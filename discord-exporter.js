// ==UserScript==
// @name         Discord Thread Exporter (Full) - Emoji, Avatars, Sorting & Sanitization
// @namespace    https://github.com/therealgorgan
// @version      1.3.4
// @description  Adds an Export Thread button to Discord. Export options include images/videos/gifs, reactions, embeds, inline emojis, avatars, embed-as-data-URI, sort order, theme and output format (HTML/CSV/JSON/TXT). Filters GIF picker content (Tenor/Giphy) separately from user uploads. Sanitizes message HTML per options and auto-detects DOM message ordering. Uses GM_xmlhttpRequest for media fetching when embedding requested. Designed for Tampermonkey/Greasemonkey.
// @author       therealgorgan
// @match        https://discord.com/channels/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @connect      *
// @run-at       document-idle
// ==/UserScript==

/*
Install:
- Add this script to Tampermonkey (or Greasemonkey).
- Open a Discord channel/thread page. Click the floating "Export Thread" button to open options.
- Uncheck options you don't want. Export will scroll to load messages, then produce a downloadable file.

Notes:
- This runs locally in your browser using your logged-in Discord session; no tokens are used.
- For large threads and many media files the export may take time and produce a large file if you choose to embed media as data URIs.
- If Discord changes DOM structure significantly, selectors may need adjustments. If you encounter that, paste a sanitized sample outerHTML of a message and I'll update the selectors.

Changelog v1.3.4:
- Added GIF picker detection (Tenor, Giphy, Gfycat, Imgur)
- GIF picker videos (mp4) are now filtered when "Include GIFs" is unchecked
- User-uploaded videos and external video links are preserved when GIFs disabled
- Removed webp from automatic GIF filtering (webp is used for regular images too)
- GIF picker content detected by domain, not just file extension

Changelog v1.3.3:
- Fixed false positive emoji filtering on attachment images (image.png, etc.)
- Attachments from cdn.discordapp.com/attachments/ and media.discordapp.net/attachments/ are now always preserved
- Removed overly aggressive "short filename" heuristic that was filtering real images
- Added keyboard simulation (PageUp, Home) and wheel events to trigger Discord lazy loading
- Better avatar vs emoji detection (only small inline avatars size<=24 are treated as emoji-like)

Changelog v1.3.2:
- Improved auto-scroll to better trigger Discord's lazy loading
- Uses multiple scroll methods (scrollTop, scrollBy, scrollIntoView, scroll events)
- Better detection of the correct scrollable container
- Increased scroll interval for more reliable message loading

Changelog v1.3.1:
- Fixed "Unknown" author on continuation messages (grouped messages from same author)
- Continuation messages now inherit author and avatar from previous message

Changelog v1.3.0:
- Fixed emoji filtering to catch Discord /assets/ paths, twemoji, and larger size params
- Added handling for concatenated/malformed URLs that Discord sometimes produces
- Added SVG element filtering when inline emojis are disabled
- Improved image extraction to skip emoji-like images at source
- Added debug logging (enable via localStorage.setItem('dte_debug', 'true'))
- Added pre-export confirmation dialog with message/media counts
- Better CSS constraints for any emoji that slips through
*/

(function () {
  'use strict';

  // ---------- Configuration ----------
  const AUTO_SCROLL_INTERVAL = 1000; // ms between scrolls (increased for reliability)
  const MAX_SCROLL_ROUNDS = 350;
  const STABLE_CHECKS = 5;
  const IMAGE_FETCH_CONCURRENCY = 6;
  const STORAGE_KEY = 'dte_options_v1_full';
  const DEBUG_KEY = 'dte_debug';

  // Debug logging
  function debugLog(...args) {
    if (localStorage.getItem(DEBUG_KEY) === 'true') {
      console.log('[DTE Debug]', ...args);
    }
  }

  // Default options
  const DEFAULT_OPTIONS = {
    includeImages: true,
    includeVideos: true,
    includeGifs: true,
    includeReactions: true,     // reaction counts
    includeEmbeds: true,        // link previews, embeds
    includeInlineEmojis: true,  // small inline emoji images inside messages
    includeAvatars: true,       // user avatar icons next to messages
    embedMedia: true,           // convert media to data URIs and embed
    sort: 'ascending',          // 'ascending' = oldest -> newest, 'descending' = newest -> oldest
    theme: 'light',             // 'light' or 'dark'
    format: 'html',             // 'html', 'csv', 'json', 'txt'
    showConfirmation: true      // show pre-export confirmation dialog
  };

  // ---------- Utilities ----------
  function loadOptions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT_OPTIONS };
      const parsed = JSON.parse(raw);
      return Object.assign({}, DEFAULT_OPTIONS, parsed);
    } catch (e) {
      return { ...DEFAULT_OPTIONS };
    }
  }
  function saveOptions(opts) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(opts)); } catch (e) {}
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'style') Object.assign(node.style, attrs[k]);
      else if (k === 'html') node.innerHTML = attrs[k];
      else node.setAttribute(k, attrs[k]);
    }
    (Array.isArray(children) ? children : [children]).forEach(c => {
      if (!c) return;
      if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    });
    return node;
  }

  // ---------- URL normalization and splitting ----------
  // Discord sometimes produces concatenated URLs like:
  // "https://cdn.discordapp.com/emojis/123.png?size=16/assets/abc.svg/assets/def.svg"
  // This function splits them into individual URLs
  function normalizeAndSplitUrls(urlString) {
    if (!urlString) return [];
    const str = urlString.toString().trim();
    if (!str) return [];

    // If it's a data URI, return as-is
    if (str.startsWith('data:')) return [str];

    const urls = [];

    // Pattern to find URL boundaries - looks for http(s):// or /assets/ patterns
    // that indicate a new URL has been concatenated
    const parts = str.split(/(https?:\/\/)/i);

    let currentUrl = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (/^https?:\/\/$/i.test(part)) {
        // This is a protocol - save previous URL if exists and start new one
        if (currentUrl) {
          urls.push(...splitOnAssets(currentUrl));
        }
        currentUrl = part;
      } else if (currentUrl) {
        currentUrl += part;
      } else if (part.startsWith('/')) {
        // Relative URL
        urls.push(part);
      }
    }
    if (currentUrl) {
      urls.push(...splitOnAssets(currentUrl));
    }

    // If no URLs found, try treating the whole thing as a URL
    if (urls.length === 0 && str) {
      urls.push(str);
    }

    return urls.filter(u => u && u.length > 0).map(u => u.trim());
  }

  // Split on /assets/ boundaries that indicate concatenated Discord asset URLs
  function splitOnAssets(url) {
    if (!url) return [];
    // Look for patterns like ".png/assets/" or ".svg/assets/" which indicate concatenation
    const assetSplitPattern = /(\.(png|jpg|jpeg|gif|webp|svg|mp4|webm)(\?[^/]*)?)(\/assets\/)/gi;
    const results = [];
    let lastIndex = 0;
    let match;

    const regex = new RegExp(assetSplitPattern);
    let str = url;
    let iterations = 0;
    const maxIterations = 20;

    while ((match = assetSplitPattern.exec(url)) !== null && iterations < maxIterations) {
      iterations++;
      // Extract URL up to and including the extension and query string
      const endOfFirstUrl = match.index + match[1].length;
      const firstPart = url.substring(lastIndex, endOfFirstUrl);
      if (firstPart) results.push(firstPart);
      lastIndex = endOfFirstUrl;
    }

    // Add remaining part
    if (lastIndex < url.length) {
      const remaining = url.substring(lastIndex);
      if (remaining && remaining !== '/') {
        // If it starts with /assets/, make it a relative URL
        if (remaining.startsWith('/assets/')) {
          results.push(remaining);
        } else if (remaining.startsWith('/')) {
          results.push(remaining);
        } else {
          // Append to last result if it doesn't look like a new URL
          if (results.length > 0 && !remaining.startsWith('http')) {
            results[results.length - 1] += remaining;
          } else {
            results.push(remaining);
          }
        }
      }
    }

    return results.length > 0 ? results : [url];
  }

  // Check if a URL is from a GIF picker service (Tenor, Giphy, etc.)
  // These often serve video files (mp4) instead of actual GIFs
  function isGifPickerUrl(url) {
    if (!url) return false;
    const u = url.toString().toLowerCase();

    // Tenor (Discord's primary GIF picker)
    if (/tenor\.com/i.test(u)) {
      debugLog('Matched Tenor GIF picker:', u);
      return true;
    }
    if (/media\.tenor\./i.test(u)) {
      debugLog('Matched Tenor media:', u);
      return true;
    }

    // Giphy
    if (/giphy\.com/i.test(u)) {
      debugLog('Matched Giphy:', u);
      return true;
    }
    if (/media\d*\.giphy\./i.test(u)) {
      debugLog('Matched Giphy media:', u);
      return true;
    }

    // Gfycat
    if (/gfycat\.com/i.test(u)) {
      debugLog('Matched Gfycat:', u);
      return true;
    }

    // Imgur GIFs (often served as gifv/mp4)
    if (/imgur\.com/i.test(u) && /\.(gifv|mp4|webm)/i.test(u)) {
      debugLog('Matched Imgur video/gif:', u);
      return true;
    }

    // Discord's media proxy for GIFs (check for tenor/giphy in the URL path)
    if (/media\.discordapp\.(net|com)\/external\//i.test(u)) {
      if (/tenor|giphy|gfycat/i.test(u)) {
        debugLog('Matched Discord proxied GIF:', u);
        return true;
      }
    }

    // Check for common GIF-related patterns in URL
    if (/\/gifs?\//i.test(u) && !/attachments/i.test(u)) {
      debugLog('Matched /gif/ path pattern:', u);
      return true;
    }

    return false;
  }

  // Check if a URL is a user-uploaded or externally linked video (NOT from GIF picker)
  function isUserVideo(url) {
    if (!url) return false;
    const u = url.toString().toLowerCase();

    // Discord attachment uploads are always user content
    if (/cdn\.discord(app)?\.com\/attachments\//i.test(u)) {
      debugLog('Video is Discord attachment (user upload):', u);
      return true;
    }

    // Media proxy for attachments
    if (/media\.discordapp\.(net|com)\/attachments\//i.test(u)) {
      debugLog('Video is Discord media attachment:', u);
      return true;
    }

    // If it's not from a known GIF picker, treat it as user content
    if (!isGifPickerUrl(u)) {
      debugLog('Video is not from GIF picker (keeping):', u);
      return true;
    }

    return false;
  }

  // ---------- Emoji / URL heuristics ----------
  function isEmojiUrl(url) {
    if (!url) return false;
    try {
      const u = url.toString().toLowerCase();

      // FIRST: Check if this is a Discord attachment - these are NEVER emojis
      if (/cdn\.discord(app)?\.com\/attachments\//i.test(u)) {
        debugLog('URL is attachment (not emoji):', u);
        return false;
      }
      if (/media\.discordapp\.(net|com)\/attachments\//i.test(u)) {
        debugLog('URL is media attachment (not emoji):', u);
        return false;
      }

      // Data URIs - check if they're small (likely emoji)
      if (u.startsWith('data:') && u.length < 5000) {
        debugLog('Potential emoji data URI (small size):', u.substring(0, 100));
        return true;
      }

      // Discord CDN emoji/sticker/badge patterns (but NOT attachments - checked above)
      if (/cdn\.discord(app)?\.com\/(emojis|emoji|stickers|clan-badges|twemoji)/i.test(u)) {
        debugLog('Matched Discord CDN emoji pattern:', u);
        return true;
      }

      // Small avatars used inline (size <= 24) are likely emoji-like decorations
      if (/cdn\.discord(app)?\.com\/avatars\//i.test(u)) {
        const sizeMatch = /[?&]size=(\d+)/.exec(u);
        if (sizeMatch && parseInt(sizeMatch[1], 10) <= 24) {
          debugLog('Matched small inline avatar:', u);
          return true;
        }
        // Normal avatars are not emojis
        return false;
      }

      // Avatar decoration presets (the animated borders around avatars)
      if (/avatar-decoration-presets/i.test(u)) {
        debugLog('Matched avatar decoration preset:', u);
        return true;
      }

      // Discord assets folder (contains emojis, icons, etc.)
      if (/discord\.com\/assets\/[a-f0-9]+\.(svg|png|gif|webp)/i.test(u)) {
        debugLog('Matched Discord assets pattern:', u);
        return true;
      }
      if (/\/assets\/[a-f0-9]{16,}\.(svg|png|gif|webp)/i.test(u)) {
        debugLog('Matched /assets/ hex pattern:', u);
        return true;
      }

      // Twemoji CDN patterns
      if (/twemoji/i.test(u)) {
        debugLog('Matched twemoji pattern:', u);
        return true;
      }

      // Explicit emoji/emoticon/sticker paths
      if (u.includes('/emojis/') || u.includes('/emoji/') || u.includes('/emoticons/')) {
        debugLog('Matched explicit emoji path:', u);
        return true;
      }
      if (u.includes('clan-badges')) {
        debugLog('Matched clan-badges:', u);
        return true;
      }

      // Size parameter check - but ONLY for non-attachment URLs
      // Emojis typically have small size params (16, 20, 24, 32, 40, 48, 96)
      const sizeMatch = /[?&]size=(\d+)/.exec(u);
      if (sizeMatch) {
        const size = parseInt(sizeMatch[1], 10);
        // Only treat as emoji if size is very small AND not an attachment
        if (size <= 48 && !u.includes('/attachments/')) {
          debugLog('Matched small size param:', size, u);
          return true;
        }
      }

      // Short hex filenames (Discord asset pattern for emojis) - but NOT generic names like "image.png"
      try {
        const urlObj = new URL(u, window.location.href);
        const pathname = urlObj.pathname;
        const basename = pathname.split('/').pop() || '';
        const nameWithoutExt = basename.replace(/\.(png|webp|gif|svg|jpg|jpeg)$/i, '');

        // Discord emoji assets have 16-20 char hex names (not words like "image")
        if (/^[a-f0-9]{8,20}$/i.test(nameWithoutExt)) {
          debugLog('Matched hex filename pattern:', basename, u);
          return true;
        }
      } catch (e) {
        // URL parse failed, continue with string checks
      }

      // Generic emoji/emoticon/sticker keywords
      if (/emoji|emoticon|sticker/i.test(u)) {
        debugLog('Matched emoji keyword:', u);
        return true;
      }

    } catch (e) {
      debugLog('Error in isEmojiUrl:', e);
      // Fallback simple checks - but be conservative
      const s = ('' + url).toLowerCase();
      // Don't include /assets/ in fallback - too broad
      return s.includes('emoji') || s.includes('clan-badges');
    }
    return false;
  }

  function isInlineEmojiImage(img) {
    if (!img) return false;
    const src = (img.src || img.getAttribute('src') || '').toString();
    const cls = (img.className || '').toString();
    const alt = (img.alt || img.getAttribute('alt') || '').toString();
    const ariaLabel = (img.getAttribute('aria-label') || '').toString();

    try {
      // Class-based detection
      if (/emoji/i.test(cls)) {
        debugLog('Emoji detected by class:', cls);
        return true;
      }

      // Alt text often contains emoji character or :emoji_name:
      if (/^:[a-z0-9_]+:$/i.test(alt) || alt.length <= 2) {
        debugLog('Emoji detected by alt text:', alt);
        return true;
      }

      // Aria-label detection
      if (/emoji/i.test(ariaLabel)) {
        debugLog('Emoji detected by aria-label:', ariaLabel);
        return true;
      }

      // URL-based detection
      if (isEmojiUrl(src)) {
        return true;
      }

      // Size-based detection (natural dimensions)
      const naturalWidth = img.naturalWidth || 0;
      const naturalHeight = img.naturalHeight || 0;
      if (naturalWidth > 0 && naturalHeight > 0 && naturalWidth <= 48 && naturalHeight <= 48) {
        debugLog('Emoji detected by natural size:', naturalWidth, 'x', naturalHeight);
        return true;
      }

      // Rendered size detection
      const rect = img.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.width <= 48 && rect.height <= 48) {
        debugLog('Emoji detected by rendered size:', rect.width, 'x', rect.height);
        return true;
      }

      // Data attribute detection
      if (img.dataset && (img.dataset.type === 'emoji' || img.dataset.emoji)) {
        debugLog('Emoji detected by data attribute');
        return true;
      }

    } catch (e) {
      debugLog('Error in isInlineEmojiImage:', e);
    }
    return false;
  }

  // Check if a URL is likely a user attachment (not an emoji/icon)
  function isLikelyAttachment(url) {
    if (!url) return false;
    const u = url.toString().toLowerCase();

    // Discord attachment URLs
    if (/cdn\.discord(app)?\.com\/attachments\//i.test(u)) {
      debugLog('URL is a Discord attachment:', u);
      return true;
    }

    // Media proxy URLs (often used for external images)
    if (/media\.discordapp\.(net|com)\//i.test(u)) {
      // But check if it's not an emoji
      if (!isEmojiUrl(u)) {
        debugLog('URL is a media proxy attachment:', u);
        return true;
      }
    }

    // URLs with attachment-like patterns
    if (/\/(attachments|uploads)\//i.test(u)) {
      debugLog('URL matches attachment path:', u);
      return true;
    }

    return false;
  }

  // ---------- UI: Floating button & Modal ----------
  const opts = loadOptions();
  let exportBtn = null;
  let modal = null;
  let confirmModal = null;

  function createFloatingButton() {
    const btn = document.getElementById('dte-export-btn') || document.createElement('button');
    btn.id = 'dte-export-btn';
    btn.textContent = 'Export Thread';
    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '18px',
      right: '18px',
      zIndex: 2147483647,
      background: '#5865F2',
      color: '#fff',
      border: 'none',
      padding: '10px 14px',
      borderRadius: '8px',
      cursor: 'pointer',
      boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
      fontSize: '14px',
      fontWeight: '600',
      fontFamily: 'Inter, Roboto, Arial, sans-serif',
    });
    btn.title = 'Export this thread (click to open options)';
    document.body.appendChild(btn);
    return btn;
  }

  function createModal() {
    const backdrop = el('div', { id: 'dte-backdrop' });
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.45)', zIndex: 2147483646, display: 'flex', alignItems: 'center', justifyContent: 'center'
    });

    const box = el('div', { id: 'dte-modal' });
    Object.assign(box.style, {
      width: '760px', maxHeight: '80vh', overflow: 'auto', background: '#fff', borderRadius: '10px', padding: '18px', boxShadow: '0 18px 50px rgba(0,0,0,0.45)', color: '#111', fontFamily: 'Inter, Roboto, Arial, sans-serif'
    });

    const title = el('h3', { style: { margin: '0 0 8px 0' } }, 'Export Thread - Options');

    const form = el('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '12px' } });

    function checkboxRow(id, labelText) {
      const idAttr = 'dte-opt-' + id;
      const row = el('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: '8px' } });
      const cb = el('input', { type: 'checkbox', id: idAttr });
      const span = el('span', { style: { fontSize: '13px' } }, labelText);
      row.appendChild(cb);
      row.appendChild(span);
      return { row, cb, idAttr };
    }

    // Left column
    const left = el('div', {});
    const chImages = checkboxRow('images', 'Include images');
    const chVideos = checkboxRow('videos', 'Include videos');
    const chGifs = checkboxRow('gifs', 'Include GIFs / animated webp');
    const chReacts = checkboxRow('reactions', 'Include reactions (reaction counts)');
    const chEmbeds = checkboxRow('embeds', 'Include embeds (cards/previews)');
    const chInlineEmojis = checkboxRow('inlineemojis', 'Include inline emojis (small icons inside messages)');
    const chAvatars = checkboxRow('avatars', 'Include avatars (user icons)');
    const chEmbedMedia = checkboxRow('embedmedia', 'Embed media as data URIs (may make file large)');
    const chConfirm = checkboxRow('confirm', 'Show confirmation before export');

    left.appendChild(chImages.row);
    left.appendChild(chVideos.row);
    left.appendChild(chGifs.row);
    left.appendChild(chReacts.row);
    left.appendChild(chEmbeds.row);
    left.appendChild(chInlineEmojis.row);
    left.appendChild(chAvatars.row);
    left.appendChild(chEmbedMedia.row);
    left.appendChild(chConfirm.row);

    // Right column
    const right = el('div', {});
    const sortLabel = el('div', { style: { marginBottom: '8px' } }, 'Sort order:');
    const sortSelect = el('select', { id: 'dte-sort', style: { width: '100%', padding: '6px', marginBottom: '10px' } });
    ['ascending', 'descending'].forEach(s => sortSelect.appendChild(el('option', { value: s }, s[0].toUpperCase() + s.slice(1))));
    const themeLabel = el('div', { style: { marginBottom: '8px' } }, 'Theme for HTML export:');
    const themeSelect = el('select', { id: 'dte-theme', style: { width: '100%', padding: '6px', marginBottom: '10px' } });
    ['light', 'dark'].forEach(t => themeSelect.appendChild(el('option', { value: t }, t[0].toUpperCase() + t.slice(1))));
    const formatLabel = el('div', { style: { marginBottom: '8px' } }, 'Export format:');
    const formatSelect = el('select', { id: 'dte-format', style: { width: '100%', padding: '6px', marginBottom: '10px' } });
    ['html', 'csv', 'json', 'txt'].forEach(f => formatSelect.appendChild(el('option', { value: f }, f.toUpperCase())));

    // Debug mode toggle
    const debugLabel = el('div', { style: { marginTop: '12px', marginBottom: '8px', fontSize: '12px', color: '#666' } }, 'Debug mode (logs to console):');
    const debugSelect = el('select', { id: 'dte-debug', style: { width: '100%', padding: '6px', marginBottom: '10px', fontSize: '12px' } });
    ['off', 'on'].forEach(d => debugSelect.appendChild(el('option', { value: d }, d.toUpperCase())));
    debugSelect.value = localStorage.getItem(DEBUG_KEY) === 'true' ? 'on' : 'off';
    debugSelect.addEventListener('change', () => {
      localStorage.setItem(DEBUG_KEY, debugSelect.value === 'on' ? 'true' : 'false');
    });

    right.appendChild(sortLabel);
    right.appendChild(sortSelect);
    right.appendChild(themeLabel);
    right.appendChild(themeSelect);
    right.appendChild(formatLabel);
    right.appendChild(formatSelect);
    right.appendChild(debugLabel);
    right.appendChild(debugSelect);

    form.appendChild(left);
    form.appendChild(right);

    const buttons = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } });
    const cancelBtn = el('button', { style: { padding: '8px 12px', borderRadius: '6px', border: '1px solid #ccc', background: '#fff' } }, 'Cancel');
    const goBtn = el('button', { style: { padding: '8px 12px', borderRadius: '6px', border: 'none', background: '#5865F2', color: '#fff' } }, 'Export');

    buttons.appendChild(cancelBtn);
    buttons.appendChild(goBtn);

    box.appendChild(title);
    box.appendChild(form);
    box.appendChild(buttons);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    // Populate with saved options
    chImages.cb.checked = !!opts.includeImages;
    chVideos.cb.checked = !!opts.includeVideos;
    chGifs.cb.checked = !!opts.includeGifs;
    chReacts.cb.checked = !!opts.includeReactions;
    chEmbeds.cb.checked = !!opts.includeEmbeds;
    chInlineEmojis.cb.checked = !!opts.includeInlineEmojis;
    chAvatars.cb.checked = !!opts.includeAvatars;
    chEmbedMedia.cb.checked = !!opts.embedMedia;
    chConfirm.cb.checked = opts.showConfirmation !== false;
    sortSelect.value = opts.sort || 'ascending';
    themeSelect.value = opts.theme || 'light';
    formatSelect.value = opts.format || 'html';

    cancelBtn.addEventListener('click', () => closeModal());
    goBtn.addEventListener('click', () => {
      opts.includeImages = chImages.cb.checked;
      opts.includeVideos = chVideos.cb.checked;
      opts.includeGifs = chGifs.cb.checked;
      opts.includeReactions = chReacts.cb.checked;
      opts.includeEmbeds = chEmbeds.cb.checked;
      opts.includeInlineEmojis = chInlineEmojis.cb.checked;
      opts.includeAvatars = chAvatars.cb.checked;
      opts.embedMedia = chEmbedMedia.cb.checked;
      opts.showConfirmation = chConfirm.cb.checked;
      opts.sort = sortSelect.value;
      opts.theme = themeSelect.value;
      opts.format = formatSelect.value;
      saveOptions(opts);
      closeModal();
      runExportWithOptions(opts);
    });

    backdrop.style.display = 'none'; // hidden until opened
    modal = backdrop;
    return modal;
  }

  function createConfirmModal(stats, onConfirm, onCancel) {
    const backdrop = el('div', { id: 'dte-confirm-backdrop' });
    Object.assign(backdrop.style, {
      position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.45)', zIndex: 2147483647, display: 'flex', alignItems: 'center', justifyContent: 'center'
    });

    const box = el('div', { id: 'dte-confirm-modal' });
    Object.assign(box.style, {
      width: '420px', background: '#fff', borderRadius: '10px', padding: '18px', boxShadow: '0 18px 50px rgba(0,0,0,0.45)', color: '#111', fontFamily: 'Inter, Roboto, Arial, sans-serif'
    });

    const title = el('h3', { style: { margin: '0 0 12px 0' } }, 'Confirm Export');

    const statsDiv = el('div', { style: { marginBottom: '16px', fontSize: '14px', lineHeight: '1.6' } });
    statsDiv.innerHTML = '<strong>Export Summary:</strong><br>' +
      'Messages: ' + stats.messageCount + '<br>' +
      'Images: ' + stats.imageCount + '<br>' +
      'Videos: ' + stats.videoCount + '<br>' +
      'Emojis filtered: ' + stats.emojisFiltered + '<br>' +
      (stats.embedMedia ? '<em>Media will be embedded as data URIs (larger file)</em>' : '<em>Media will be linked (smaller file)</em>');

    const buttons = el('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } });
    const cancelBtn = el('button', { style: { padding: '8px 12px', borderRadius: '6px', border: '1px solid #ccc', background: '#fff' } }, 'Cancel');
    const confirmBtn = el('button', { style: { padding: '8px 12px', borderRadius: '6px', border: 'none', background: '#5865F2', color: '#fff' } }, 'Confirm Export');

    cancelBtn.addEventListener('click', () => {
      backdrop.remove();
      onCancel();
    });
    confirmBtn.addEventListener('click', () => {
      backdrop.remove();
      onConfirm();
    });

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);

    box.appendChild(title);
    box.appendChild(statsDiv);
    box.appendChild(buttons);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    return backdrop;
  }

  function openModal() { if (!modal) createModal(); modal.style.display = 'flex'; }
  function closeModal() { if (modal) modal.style.display = 'none'; }

  // ---------- DOM helpers ----------
  function findMessageContainer() {
    const selectors = [
      'div[role="log"]',
      'div.scrollerInner-2YIMLh',
      'div[class*="scroller"]',
      'div[class*="messages-"]',
      'div[class*="content-"]'
    ];
    for (const s of selectors) {
      const elSel = document.querySelector(s);
      if (elSel && elSel.querySelector('[role="article"], [data-message-id]')) return elSel;
    }
    return document.querySelector('div[role="log"]') || document.scrollingElement || document.documentElement;
  }

  async function autoLoadAllMessages(container, onProgress) {
    if (!container) container = findMessageContainer();
    if (!container) throw new Error('Message container not found');

    // Find the actual scrollable element - Discord nests scrollers
    let scroller = container;
    const possibleScrollers = [
      document.querySelector('[class*="messagesWrapper"] [class*="scroller"]'),
      document.querySelector('div[class*="chat"] [class*="scroller"]'),
      container.closest('[class*="scroller"]'),
      container.querySelector('[class*="scroller"]'),
      document.querySelector('[class*="scrollerInner"]')?.parentElement,
      container
    ].filter(Boolean);

    for (const el of possibleScrollers) {
      if (el && el.scrollHeight > el.clientHeight) {
        scroller = el;
        debugLog('Found scrollable container:', el.className);
        break;
      }
    }

    let prevCount = -1;
    let unchanged = 0;
    let rounds = 0;

    // Focus the scroller to enable keyboard navigation
    try {
      scroller.focus();
      scroller.click();
    } catch (e) {}

    // Helper to simulate keyboard events
    function simulateKey(key, keyCode) {
      const eventInit = {
        key: key,
        code: key,
        keyCode: keyCode,
        which: keyCode,
        bubbles: true,
        cancelable: true
      };
      scroller.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      document.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    }

    // Helper to simulate wheel scroll
    function simulateWheel(deltaY) {
      const wheelEvent = new WheelEvent('wheel', {
        deltaY: deltaY,
        deltaMode: 0,
        bubbles: true,
        cancelable: true
      });
      scroller.dispatchEvent(wheelEvent);
    }

    while (rounds < MAX_SCROLL_ROUNDS && unchanged < STABLE_CHECKS) {
      rounds++;

      // Method 1: Direct scroll manipulation
      scroller.scrollTop = 0;

      // Method 2: scrollTo with behavior
      try {
        scroller.scrollTo({ top: 0, behavior: 'instant' });
      } catch (e) {}

      // Method 3: Simulate wheel scroll up (negative = scroll up)
      simulateWheel(-2000);

      // Method 4: Simulate Page Up key press (keyCode 33)
      simulateKey('PageUp', 33);

      // Method 5: Simulate Home key (keyCode 36)
      if (rounds % 5 === 0) {
        simulateKey('Home', 36);
      }

      // Method 6: Find first message and scroll into view
      const firstMsg = scroller.querySelector('[role="article"], [data-message-id]');
      if (firstMsg && rounds % 3 === 0) {
        try {
          firstMsg.scrollIntoView({ behavior: 'instant', block: 'start' });
        } catch (e) {}
      }

      // Method 7: Dispatch scroll event
      try {
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      } catch (e) {}

      await new Promise(r => setTimeout(r, AUTO_SCROLL_INTERVAL));

      const msgs = getMessageElements();
      if (onProgress) onProgress({ rounds, messages: msgs.length });

      debugLog('Scroll round', rounds, '- messages:', msgs.length, '- scrollTop:', scroller.scrollTop, '- scrollHeight:', scroller.scrollHeight);

      if (msgs.length === prevCount) unchanged++;
      else { prevCount = msgs.length; unchanged = 0; }
    }

    debugLog('Auto-scroll complete. Total rounds:', rounds, '- Final message count:', prevCount);
    return getMessageElements();
  }

  function getMessageElements() {
    const container = findMessageContainer();
    if (!container) return [];
    let els = Array.from(container.querySelectorAll('[role="article"]'));
    if (!els.length) {
      els = Array.from(container.querySelectorAll('[data-message-id], .message-2qnXI6, .container-2sjPya'));
    }
    return els.filter(el => el.offsetParent !== null || el === document.activeElement);
  }

  // ---------- Message extraction ----------
  // Track the last known author for continuation messages
  let lastKnownAuthor = '';
  let lastKnownAvatar = '';

  function extractMessageData(msgEl, options) {
    const messageId = msgEl.getAttribute('data-message-id') || msgEl.dataset?.messageId || msgEl.id || '';
    let author = '';
    let isContinuation = false;

    try {
      const header = msgEl.querySelector('h3');
      if (header) {
        const nameEl = header.querySelector('span') || header.firstChild;
        author = nameEl ? nameEl.textContent.trim() : header.textContent.trim();
      } else {
        const name = msgEl.querySelector('[class*="username"]') || msgEl.querySelector('[class*="author-"]') || msgEl.querySelector('[id^="user-"]');
        author = name ? name.textContent.trim() : '';
      }

      // Check if this is a continuation message (no header, grouped with previous)
      if (!author) {
        // Look for continuation message indicators
        const hasNoHeader = !msgEl.querySelector('h3') && !msgEl.querySelector('[class*="username"]');
        const isCompact = msgEl.closest('[class*="groupStart"]') === null;

        if (hasNoHeader) {
          isContinuation = true;
          author = lastKnownAuthor; // Inherit from previous message
          debugLog('Continuation message detected, inheriting author:', author);
        }
      }

      // Update last known author if we found one
      if (author && !isContinuation) {
        lastKnownAuthor = author;
      }
    } catch (e) { author = ''; }

    let timestamp = '';
    try {
      const timeEl = msgEl.querySelector('time') || msgEl.querySelector('a[aria-label]');
      if (timeEl) timestamp = timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || timeEl.textContent.trim();
    } catch (e) { timestamp = ''; }

    let avatar = '';
    try {
      // Look specifically for avatar images (usually first img in message or with avatar class)
      const avatarImg = msgEl.querySelector('img[class*="avatar"]') || msgEl.querySelector('[class*="avatar"] img');
      if (avatarImg) {
        avatar = avatarImg.src || '';
      } else {
        // Fallback: first img that looks like an avatar (small, in header area)
        const firstImg = msgEl.querySelector('img');
        if (firstImg) {
          const rect = firstImg.getBoundingClientRect();
          // Avatars are typically small and square-ish
          if (rect.width > 0 && rect.width <= 48 && rect.height <= 48) {
            avatar = firstImg.src || '';
          }
        }
      }

      // For continuation messages, inherit avatar from previous message
      if (!avatar && isContinuation) {
        avatar = lastKnownAvatar;
        debugLog('Continuation message inheriting avatar');
      }

      // Update last known avatar if we found one
      if (avatar && !isContinuation) {
        lastKnownAvatar = avatar;
      }
    } catch (e) { avatar = ''; }

    let contentHtml = '';
    try {
      const contentEl = msgEl.querySelector('[class*="markup"], [class*="messageContent"], [data-slate-node="element"], [data-slate-node="text"]');
      if (contentEl) contentHtml = contentEl.innerHTML.trim();
      else contentHtml = msgEl.innerHTML || '';
    } catch (e) { contentHtml = msgEl.innerText || ''; }

    const imageUrls = [];
    const videoUrls = [];
    const filteredEmojiUrls = []; // Track what we filter for debugging

    try {
      // Process all images, filtering based on options
      Array.from(msgEl.querySelectorAll('img')).forEach(img => {
        const src = img.src || img.getAttribute('src') || '';
        if (!src) return;

        // Normalize and split potentially concatenated URLs
        const urls = normalizeAndSplitUrls(src);

        urls.forEach(url => {
          // Skip if it looks like an avatar and we already captured it
          if (url === avatar) return;

          // Check if it's an emoji
          const imgIsEmoji = isInlineEmojiImage(img) || isEmojiUrl(url);

          if (imgIsEmoji) {
            if (!options.includeInlineEmojis) {
              debugLog('Filtered emoji image:', url);
              filteredEmojiUrls.push(url);
              return; // Skip this image
            }
          }

          // Check if it's a real attachment
          if (isLikelyAttachment(url) || !imgIsEmoji) {
            imageUrls.push(url);
          } else if (options.includeInlineEmojis) {
            imageUrls.push(url);
          } else {
            debugLog('Filtered non-attachment image:', url);
            filteredEmojiUrls.push(url);
          }
        });
      });

      // Process videos
      Array.from(msgEl.querySelectorAll('video, source')).forEach(v => {
        if (v.src) videoUrls.push(v.src);
      });

      // Process background images in styles
      Array.from(msgEl.querySelectorAll('[style]')).forEach(node => {
        const s = node.getAttribute('style');
        if (s && s.includes('url(')) {
          const m = /url\(['"]?([^'")]+)['"]?\)/.exec(s);
          if (m && m[1]) {
            const url = m[1];
            const urls = normalizeAndSplitUrls(url);
            urls.forEach(u => {
              if (u.includes('.mp4') || u.includes('.webm')) {
                videoUrls.push(u);
              } else {
                // Check if it's an emoji
                if (!options.includeInlineEmojis && isEmojiUrl(u)) {
                  debugLog('Filtered background emoji:', u);
                  filteredEmojiUrls.push(u);
                } else {
                  imageUrls.push(u);
                }
              }
            });
          }
        }
      });
    } catch (e) {
      debugLog('Error extracting media:', e);
    }

    let embeds = [];
    try {
      const embedEls = Array.from(msgEl.querySelectorAll('iframe, .embed, .embedWrapper-3t2I1I, .richEmbed-2k2e0p, [class*="embed-"]'));
      embeds = embedEls.map(e => ({ html: e.outerHTML, text: e.textContent?.trim?.() || '' }));
    } catch (e) { embeds = []; }

    let reactions = [];
    try {
      const reactionContainers = Array.from(msgEl.querySelectorAll('[class*="reactions-"], [class*="reaction-"], [data-reaction], [aria-label*="reacted"]'));
      const found = new Set();
      reactionContainers.forEach(rc => {
        Array.from(rc.querySelectorAll('span, button, div')).forEach(child => {
          const txt = (child.textContent || '').trim();
          if (txt && txt.length < 60) found.add(txt);
        });
      });
      Array.from(msgEl.querySelectorAll('[aria-label]')).forEach(a => {
        const al = a.getAttribute('aria-label');
        if (al && /react/i.test(al) && al.length < 120) found.add(al);
      });
      reactions = Array.from(found).map(s => s.trim()).filter(Boolean);
    } catch (e) { reactions = []; }

    return {
      messageId,
      author,
      timestamp,
      avatar,
      contentHtml,
      imageUrls: Array.from(new Set(imageUrls)),
      videoUrls: Array.from(new Set(videoUrls)),
      filteredEmojiUrls: Array.from(new Set(filteredEmojiUrls)),
      embeds,
      reactions
    };
  }

  // ---------- Sanitization ----------
  function sanitizeContentHtml(contentHtml, options) {
    if (!contentHtml) return contentHtml;
    const tmp = document.createElement('div');
    tmp.innerHTML = contentHtml;

    // Remove SVG elements (often used for emojis/icons) when emojis disabled
    if (!options.includeInlineEmojis) {
      tmp.querySelectorAll('svg').forEach(svg => {
        debugLog('Removing SVG element from content');
        svg.remove();
      });
    }

    // Remove inline emoji images if requested
    if (!options.includeInlineEmojis) {
      tmp.querySelectorAll('img').forEach(img => {
        const src = img.src || img.getAttribute('src') || '';
        // Check multiple indicators
        if (isInlineEmojiImage(img) || isEmojiUrl(src)) {
          debugLog('Removing emoji img from contentHtml:', src);
          img.remove();
        }
      });

      // Remove background images that are emojis
      tmp.querySelectorAll('[style]').forEach(node => {
        const s = node.getAttribute('style') || '';
        if (s && /url\(/i.test(s)) {
          const m = /url\(['"]?([^'")]+)['"]?\)/i.exec(s);
          if (m && m[1]) {
            const urls = normalizeAndSplitUrls(m[1]);
            const hasEmoji = urls.some(u => isEmojiUrl(u));
            if (hasEmoji) {
              debugLog('Removing style with emoji background:', m[1]);
              node.removeAttribute('style');
            }
          }
        }
      });
    }

    // Remove <img> entirely if images disabled
    if (!options.includeImages) {
      tmp.querySelectorAll('img').forEach(n => n.remove());
      tmp.querySelectorAll('[style]').forEach(node => {
        const s = node.getAttribute('style') || '';
        if (s && /url\(/i.test(s)) node.removeAttribute('style');
      });
    } else {
      if (!options.includeGifs) {
        tmp.querySelectorAll('img').forEach(img => {
          const src = (img.src || '').toLowerCase();
          const ext = src.split('?')[0].split('.').pop().toLowerCase();
          // Filter by extension
          if (ext === 'gif' || ext === 'apng') {
            debugLog('Removing GIF by extension:', src);
            img.remove();
            return;
          }
          // Filter GIF picker images (Tenor, Giphy served as webp/png)
          if (isGifPickerUrl(src)) {
            debugLog('Removing GIF picker image:', src);
            img.remove();
          }
        });
      }
    }

    if (!options.includeVideos) {
      tmp.querySelectorAll('video, source').forEach(n => n.remove());
    } else if (!options.includeGifs) {
      // Remove GIF picker videos but keep user-uploaded videos
      tmp.querySelectorAll('video, source').forEach(v => {
        const src = v.src || v.getAttribute('src') || '';
        if (isGifPickerUrl(src)) {
          debugLog('Removing GIF picker video from content:', src);
          v.remove();
        }
      });
    }
    if (!options.includeEmbeds) tmp.querySelectorAll('iframe, .embed, [class*="embed-"]').forEach(n => n.remove());
    if (!options.includeReactions) tmp.querySelectorAll('[class*="reaction"], [class*="reactions-"], [aria-label*="react"]').forEach(n => n.remove());

    return tmp.innerHTML;
  }

  // ---------- Media fetching ----------
  function fetchAsDataUri(url) {
    return new Promise((resolve) => {
      if (!url) return resolve({ url, dataUri: null, error: 'empty' });
      if (url.startsWith('data:')) return resolve({ url, dataUri: url, error: null });
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'arraybuffer',
        onload(res) {
          try {
            const arr = new Uint8Array(res.response);
            let binary = '';
            const chunk = 0x8000;
            for (let i = 0; i < arr.length; i += chunk) {
              binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
            }
            const b64 = btoa(binary);
            let mime = '';
            if (res.responseHeaders) {
              const m = /content-type:\s*([^\r\n;]+)/i.exec(res.responseHeaders);
              if (m) mime = m[1];
            }
            if (!mime) {
              const ext = url.split('?')[0].split('.').pop().toLowerCase();
              const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', svg: 'image/svg+xml' };
              mime = map[ext] || 'application/octet-stream';
            }
            const dataUri = 'data:' + mime + ';base64,' + b64;
            resolve({ url, dataUri, error: null });
          } catch (err) {
            resolve({ url, dataUri: null, error: 'conversion_failed' });
          }
        },
        onerror(err) { resolve({ url, dataUri: null, error: 'request_failed' }); },
        ontimeout() { resolve({ url, dataUri: null, error: 'timeout' }); }
      });
    });
  }

  async function fetchAllDataUris(urls, onProgress) {
    const unique = Array.from(new Set(urls.filter(u => !!u)));
    const results = {};
    let index = 0;
    let active = 0;
    return new Promise((resolve) => {
      function next() {
        if (index >= unique.length && active === 0) return resolve(results);
        while (active < IMAGE_FETCH_CONCURRENCY && index < unique.length) {
          const url = unique[index++];
          active++;
          fetchAsDataUri(url).then(r => {
            results[url] = r;
            active--;
            if (onProgress) onProgress({ url, done: Object.keys(results).length, total: unique.length });
            next();
          });
        }
      }
      next();
    });
  }

  // ---------- Export builders ----------
  function buildHtmlExport(title, threadUrl, messages, imageMap, theme = 'light', options = {}) {
    // CSS: constrain content images and force emoji-like images small
    // Added more aggressive emoji size constraints
    const styleLight = '\n' +
      'body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial; background:#f6f8fa; color:#222; }\n' +
      '.container { max-width:980px; margin:20px auto; background:#fff; padding:20px; border-radius:8px; box-shadow:0 8px 24px rgba(15,15,15,0.08); }\n' +
      '.message { border-bottom:1px solid #eee; padding:14px 0; display:flex; gap:12px; align-items:flex-start; }\n' +
      '.meta { font-size:13px; color:#555; margin-bottom:6px; }\n' +
      '.author { font-weight:700; margin-right:8px; }\n' +
      '.time { color:#888; font-size:12px; }\n' +
      '.content { margin:6px 0; white-space:pre-wrap; word-break:break-word; }\n' +
      '.content img { max-width:100%; max-height:480px; height:auto; vertical-align:middle; }\n' +
      '.content img.emoji, .content img[src*="emoji"], .content img[src*="/assets/"], .content img[alt^=":"], .content img[alt$=":"] { max-width:22px !important; max-height:22px !important; width:22px !important; height:22px !important; vertical-align:middle; display:inline !important; }\n' +
      '.attachments img.emoji { max-width:22px !important; max-height:22px !important; width:22px !important; height:22px !important; }\n' +
      '.attachments img:not(.emoji) { max-width:100%; height:auto; display:block; margin-top:8px; border-radius:6px; }\n' +
      '.attachments video { max-width:100%; height:auto; display:block; margin-top:8px; border-radius:6px; }\n' +
      '.avatar { width:36px; height:36px; border-radius:50%; flex-shrink:0; object-fit:cover; }\n' +
      '.message-body { flex:1; min-width:0; }\n' +
      '.reactions { margin-top:6px; color:#555; font-size:13px; }\n' +
      'a { color:#3b82f6; word-break:break-all; }\n' +
      'img[src*="clan-badges"], img[src*="twemoji"], img[src*="/emojis/"] { max-width:22px !important; max-height:22px !important; width:22px !important; height:22px !important; }\n';

    const styleDark = '\n' +
      'body { font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial; background:#0f1720; color:#e6eef8; }\n' +
      '.container { max-width:980px; margin:20px auto; background:#0b1220; padding:20px; border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,0.5); }\n' +
      '.message { border-bottom:1px solid rgba(255,255,255,0.04); padding:14px 0; display:flex; gap:12px; align-items:flex-start; }\n' +
      '.meta { font-size:13px; color:#9fb0d8; margin-bottom:6px; }\n' +
      '.author { font-weight:700; margin-right:8px; color:#fff; }\n' +
      '.time { color:#8aa; font-size:12px; }\n' +
      '.content { margin:6px 0; white-space:pre-wrap; word-break:break-word; }\n' +
      '.content img { max-width:100%; max-height:480px; height:auto; vertical-align:middle; }\n' +
      '.content img.emoji, .content img[src*="emoji"], .content img[src*="/assets/"], .content img[alt^=":"], .content img[alt$=":"] { max-width:22px !important; max-height:22px !important; width:22px !important; height:22px !important; vertical-align:middle; display:inline !important; }\n' +
      '.attachments img.emoji { max-width:22px !important; max-height:22px !important; width:22px !important; height:22px !important; }\n' +
      '.attachments img:not(.emoji) { max-width:100%; height:auto; display:block; margin-top:8px; border-radius:6px; }\n' +
      '.attachments video { max-width:100%; height:auto; display:block; margin-top:8px; border-radius:6px; }\n' +
      '.avatar { width:36px; height:36px; border-radius:50%; flex-shrink:0; object-fit:cover; }\n' +
      '.message-body { flex:1; min-width:0; }\n' +
      '.reactions { margin-top:6px; color:#9fb0d8; font-size:13px; }\n' +
      'a { color:#60a5fa; word-break:break-all; }\n' +
      'img[src*="clan-badges"], img[src*="twemoji"], img[src*="/emojis/"] { max-width:22px !important; max-height:22px !important; width:22px !important; height:22px !important; }\n';

    function escapeHtml(s) {
      if (!s) return '';
      return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    }

    const rows = messages.map(m => {
      let content = m.contentHtml || '';

      // Replace media URLs inside content with embedded data URIs when available
      (m.imageUrls || []).forEach(url => {
        const mapped = imageMap[url];
        if (mapped && mapped.dataUri) content = content.replaceAll(url, mapped.dataUri);
      });
      (m.videoUrls || []).forEach(url => {
        const mapped = imageMap[url];
        if (mapped && mapped.dataUri) content = content.replaceAll(url, mapped.dataUri);
      });

      // Build attachments HTML; mark emoji-like attachments with class="emoji"
      let attachmentsHtml = '';
      (m.imageUrls || []).forEach(url => {
        const mapped = imageMap[url];
        const src = (mapped && mapped.dataUri) ? mapped.dataUri : url;
        const emojiCls = isEmojiUrl(url) ? 'emoji' : '';
        attachmentsHtml += '<img class="' + emojiCls + '" src="' + escapeHtml(src) + '" alt="' + escapeHtml(url) + '">';
      });
      (m.videoUrls || []).forEach(url => {
        const mapped = imageMap[url];
        const src = (mapped && mapped.dataUri) ? mapped.dataUri : url;
        attachmentsHtml += '<video controls src="' + escapeHtml(src) + '"></video>';
      });

      const reactionsHtml = (m.reactions && m.reactions.length) ? '<div class="reactions">' + escapeHtml(m.reactions.join(' . ')) + '</div>' : '';
      const embedHtml = (m.embeds && m.embeds.length) ? '<div class="embeds">' + m.embeds.map(e => '<div class="embed">' + escapeHtml(e.text || '') + (e.html || '') + '</div>').join('') + '</div>' : '';

      const avatarSrc = (m.avatar && imageMap[m.avatar] && imageMap[m.avatar].dataUri) ? imageMap[m.avatar].dataUri : (m.avatar || '');
      const avatarImg = avatarSrc ? '<img class="avatar" src="' + escapeHtml(avatarSrc) + '" />' : (options.includeAvatars ? '' : '');

      const authorEsc = escapeHtml(m.author || 'Unknown');
      const timeEsc = escapeHtml(m.timestamp || '');

      return '\n' +
        '        <div class="message" data-message-id="' + escapeHtml(m.messageId || '') + '">\n' +
        '          ' + (options.includeAvatars ? avatarImg : '') + '\n' +
        '          <div class="message-body">\n' +
        '            <div class="meta"><span class="author">' + authorEsc + '</span><span class="time">' + timeEsc + '</span></div>\n' +
        '            <div class="content">' + content + '</div>\n' +
        '            <div class="attachments">' + attachmentsHtml + '</div>\n' +
        '            ' + embedHtml + '\n' +
        '            ' + reactionsHtml + '\n' +
        '          </div>\n' +
        '        </div>\n' +
        '      ';
    }).join('\n');

    const html = '<!doctype html>\n' +
      '<html>\n' +
      '<head>\n' +
      '<meta charset="utf-8">\n' +
      '<title>' + escapeHtml(title) + '</title>\n' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
      '<style>' + (theme === 'dark' ? styleDark : styleLight) + '</style>\n' +
      '</head>\n' +
      '<body>\n' +
      '<div class="container">\n' +
      '  <h2>' + escapeHtml(title) + '</h2>\n' +
      '  <p><a href="' + escapeHtml(threadUrl) + '" target="_blank" rel="noopener">Open in Discord</a></p>\n' +
      '  ' + rows + '\n' +
      '</div>\n' +
      '</body>\n' +
      '</html>';
    return html;
  }

  function buildJsonExport(threadUrl, messages, imageMap, embedMedia) {
    const out = messages.map(m => ({
      messageId: m.messageId,
      author: m.author,
      timestamp: m.timestamp,
      contentHtml: m.contentHtml,
      avatar: (m.avatar ? (imageMap[m.avatar] && imageMap[m.avatar].dataUri ? imageMap[m.avatar].dataUri : m.avatar) : null),
      images: (m.imageUrls || []).map(u => (imageMap[u] && imageMap[u].dataUri) ? imageMap[u].dataUri : u),
      videos: (m.videoUrls || []).map(u => (imageMap[u] && imageMap[u].dataUri) ? imageMap[u].dataUri : u),
      embeds: m.embeds || [],
      reactions: m.reactions || []
    }));
    return JSON.stringify({ threadUrl, exportedAt: new Date().toISOString(), messages: out }, null, 2);
  }

  function buildCsvExport(messages, imageMap, embedMedia) {
    function stripHtml(s) {
      if (!s) return '';
      const tmp = document.createElement('div');
      tmp.innerHTML = s;
      return tmp.textContent || tmp.innerText || '';
    }
    const rows = [['messageId', 'timestamp', 'author', 'content', 'media', 'reactions', 'embeds']];
    messages.forEach(m => {
      const contentText = stripHtml(m.contentHtml);
      const mediaArr = [];
      (m.imageUrls || []).forEach(u => {
        const mapped = imageMap[u];
        mediaArr.push((mapped && mapped.dataUri) ? mapped.dataUri : u);
      });
      (m.videoUrls || []).forEach(u => {
        const mapped = imageMap[u];
        mediaArr.push((mapped && mapped.dataUri) ? mapped.dataUri : u);
      });
      const mediaCell = mediaArr.join(' | ');
      const reacts = (m.reactions || []).join(' | ');
      const embeds = (m.embeds || []).map(e => (e.text || '').replace(/\s+/g, ' ').trim()).join(' | ');
      rows.push([m.messageId || '', m.timestamp || '', m.author || '', contentText || '', mediaCell, reacts, embeds]);
    });
    return rows.map(row => row.map(cell => {
      const s = (cell === null || cell === undefined) ? '' : String(cell);
      if (s.includes('"') || s.includes(',') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    }).join(',')).join('\n');
  }

  function buildTxtExport(messages, imageMap, embedMedia) {
    const out = [];
    messages.forEach(m => {
      out.push('--- Message: ' + (m.messageId || ''));
      out.push('Author: ' + (m.author || ''));
      out.push('Time: ' + (m.timestamp || ''));
      const tmp = document.createElement('div');
      tmp.innerHTML = m.contentHtml || '';
      out.push('Content:');
      out.push(tmp.textContent || '');
      const mediaArr = [];
      (m.imageUrls || []).forEach(u => mediaArr.push((imageMap[u] && imageMap[u].dataUri) ? imageMap[u].dataUri : u));
      (m.videoUrls || []).forEach(u => mediaArr.push((imageMap[u] && imageMap[u].dataUri) ? imageMap[u].dataUri : u));
      if (mediaArr.length) {
        out.push('Media:');
        mediaArr.forEach(u => out.push(' - ' + u));
      }
      if (m.reactions && m.reactions.length) out.push('Reactions: ' + m.reactions.join(' | '));
      if (m.embeds && m.embeds.length) {
        out.push('Embeds:');
        m.embeds.forEach(e => out.push(' - ' + (e.text || '').replace(/\s+/g, ' ').trim()));
      }
      out.push('');
    });
    return out.join('\n');
  }

  // ---------- Timestamp parsing / DOM order detection ----------
  function parseTimestampToNumber(ts) {
    if (!ts) return 0;
    const n = Date.parse(ts);
    if (!isNaN(n)) return n;
    const m = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/.exec(ts);
    if (m) {
      const p = Date.parse(m[1]);
      if (!isNaN(p)) return p;
    }
    const nums = ts.match(/\d{4}[-/]\d{2}[-/]\d{2}/);
    if (nums) {
      const s = Date.parse(nums[0]);
      if (!isNaN(s)) return s;
    }
    return 0;
  }

  // ---------- Main export orchestration ----------
  async function runExportWithOptions(options) {
    exportBtn.disabled = true;
    const originalText = exportBtn.textContent;
    try {
      exportBtn.textContent = 'Loading messages...';
      const container = findMessageContainer();
      const nodes = await autoLoadAllMessages(container, (p) => {
        exportBtn.textContent = 'Loading... msgs:' + (p.messages || '');
      });
      exportBtn.textContent = 'Collecting messages...';

      // Reset continuation message tracking
      lastKnownAuthor = '';
      lastKnownAvatar = '';

      // Extract messages with options (for filtering during extraction)
      let messages = nodes.map(n => extractMessageData(n, options));

      // Detect DOM order
      let domIsNewestFirst = false;
      if (messages.length >= 2) {
        const firstTs = parseTimestampToNumber(messages[0].timestamp);
        const lastTs = parseTimestampToNumber(messages[messages.length - 1].timestamp);
        if (firstTs && lastTs && firstTs > lastTs) domIsNewestFirst = true;
      }

      // Desired: ascending = oldest->newest; descending = newest->oldest
      if ((domIsNewestFirst && options.sort === 'ascending') || (!domIsNewestFirst && options.sort === 'descending')) {
        messages = messages.reverse();
      }

      // Track filtered emojis for stats
      let totalEmojisFiltered = 0;

      // Sanitize contentHtml and filter media arrays
      messages.forEach(m => {
        m.contentHtml = sanitizeContentHtml(m.contentHtml || '', options);

        // Additional filtering pass on imageUrls (redundant safety)
        const beforeCount = m.imageUrls.length;
        m.imageUrls = (m.imageUrls || []).filter(u => {
          if (!options.includeImages) return false;
          if (!options.includeInlineEmojis && isEmojiUrl(u)) {
            debugLog('Post-filter: removing emoji URL:', u);
            return false;
          }
          if (!options.includeGifs) {
            const ext = (u.split('?')[0].split('.').pop() || '').toLowerCase();
            if (ext === 'gif' || ext === 'apng') {
              debugLog('Post-filter: removing GIF by extension:', u);
              return false;
            }
            if (isGifPickerUrl(u)) {
              debugLog('Post-filter: removing GIF picker image:', u);
              return false;
            }
          }
          return true;
        });
        totalEmojisFiltered += (m.filteredEmojiUrls || []).length + (beforeCount - m.imageUrls.length);

        m.videoUrls = (m.videoUrls || []).filter(u => {
          if (!options.includeVideos) return false;
          // Filter out GIF picker videos (Tenor, Giphy, etc.) when GIFs disabled
          if (!options.includeGifs && isGifPickerUrl(u)) {
            debugLog('Filtering GIF picker video:', u);
            return false;
          }
          return true;
        });

        if (!options.includeEmbeds) m.embeds = [];
        if (!options.includeReactions) m.reactions = [];
        if (!options.includeAvatars) m.avatar = '';
      });

      // Calculate stats for confirmation
      const stats = {
        messageCount: messages.length,
        imageCount: messages.reduce((sum, m) => sum + (m.imageUrls || []).length, 0),
        videoCount: messages.reduce((sum, m) => sum + (m.videoUrls || []).length, 0),
        emojisFiltered: totalEmojisFiltered,
        embedMedia: options.embedMedia
      };

      debugLog('Export stats:', stats);

      // Show confirmation if enabled
      if (options.showConfirmation) {
        exportBtn.textContent = 'Awaiting confirmation...';
        const confirmed = await new Promise((resolve) => {
          createConfirmModal(stats, () => resolve(true), () => resolve(false));
        });
        if (!confirmed) {
          exportBtn.textContent = originalText;
          exportBtn.disabled = false;
          return;
        }
      }

      // Build list of media URLs to fetch if embedding requested
      const allMedia = [];
      messages.forEach(m => {
        if (m.avatar) allMedia.push(m.avatar);
        (m.imageUrls || []).forEach(u => allMedia.push(u));
        (m.videoUrls || []).forEach(u => allMedia.push(u));
      });
      const uniqueMedia = Array.from(new Set(allMedia.filter(Boolean)));

      let imageMap = {};
      if (options.embedMedia && uniqueMedia.length) {
        exportBtn.textContent = 'Fetching ' + uniqueMedia.length + ' assets...';
        imageMap = await fetchAllDataUris(uniqueMedia, (s) => {
          exportBtn.textContent = 'Fetching assets ' + s.done + '/' + s.total;
        });
      } else {
        uniqueMedia.forEach(u => imageMap[u] = { url: u, dataUri: null, error: 'not_fetched' });
      }

      exportBtn.textContent = 'Building file...';
      const title = document.title || 'Discord Thread Export';
      const threadUrl = window.location.href;
      let outContent = '';
      let filename = 'discord-thread-' + (threadUrl.split('/').slice(-1)[0] || Date.now());

      if (options.format === 'html') {
        outContent = buildHtmlExport(title, threadUrl, messages, imageMap, options.theme || 'light', options);
        filename += '.html';
        downloadBlob(filename, outContent, 'text/html;charset=utf-8');
      } else if (options.format === 'json') {
        outContent = buildJsonExport(threadUrl, messages, imageMap, options.embedMedia);
        filename += '.json';
        downloadBlob(filename, outContent, 'application/json;charset=utf-8');
      } else if (options.format === 'csv') {
        outContent = buildCsvExport(messages, imageMap, options.embedMedia);
        filename += '.csv';
        downloadBlob(filename, outContent, 'text/csv;charset=utf-8');
      } else if (options.format === 'txt') {
        outContent = buildTxtExport(messages, imageMap, options.embedMedia);
        filename += '.txt';
        downloadBlob(filename, outContent, 'text/plain;charset=utf-8');
      } else {
        alert('Unknown format: ' + options.format);
      }

      exportBtn.textContent = 'Export complete';
      GM_notification && GM_notification({ text: 'Export complete: ' + filename, title: 'Discord Export', timeout: 4000 });
      setTimeout(() => { exportBtn.textContent = originalText; exportBtn.disabled = false; }, 1500);
    } catch (err) {
      console.error('Export failed', err);
      alert('Export failed: ' + (err && err.message ? err.message : err));
      exportBtn.textContent = originalText;
      exportBtn.disabled = false;
    }
  }

  function downloadBlob(filename, content, mime) {
    mime = mime || 'text/html;charset=utf-8';
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---------- Initialization ----------
  function ensureButton() {
    if (!exportBtn) exportBtn = createFloatingButton();
    if (!modal) createModal();
    exportBtn.onclick = () => openModal();
  }

  const observer = new MutationObserver(() => {
    if (!document.body.contains(document.getElementById('dte-export-btn'))) ensureButton();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  ensureButton();

  // Keyboard shortcut Ctrl+Shift+E to open modal
  window.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyE') openModal();
  });

})();
