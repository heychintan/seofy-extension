// Seofy popup — single-page scrape, multi-tab UI.

const $  = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const state = {
  data: null,         // result of scrapePage
  tab:  'overview',   // initial tab (matches aria-current in markup)
  // images sub-state
  imgTypes: new Set(['ALL']),
  imgView:  'list',
  // links sub-state
  linkFilter: 'ALL',  // ALL | INTERNAL | EXTERNAL
};

// ---------- entry ----------
init().catch(err => showError(err?.message || String(err)));

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || /^(chrome|edge|about|chrome-extension|view-source):/i.test(tab.url) || tab.url.startsWith('https://chrome.google.com/webstore')) {
    return showError();
  }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: scrapePage,
    });
  } catch (e) {
    return showError(e.message);
  }

  state.data = results?.[0]?.result;
  if (!state.data) return showError('No data returned from page.');

  $('#loading').hidden = true;

  // pre-render all tabs once (cheap), then show the active one
  renderOverview();
  renderHeadings();
  renderLinks();
  renderImages();
  renderSchema();
  renderSocial();
  renderAdvanced();

  showTab(state.tab);
  bindNav();

  // hydrate image sizes in background
  hydrateImageSizes();
}

// ---------- in-page scraper (executes in tab) ----------
function scrapePage() {
  const out = {
    url: location.href,
    finalUrl: location.href,
    title:        document.querySelector('title')?.textContent?.trim() || '',
    description:  document.querySelector('meta[name="description"]')?.content?.trim() || '',
    canonical:    document.querySelector('link[rel="canonical"]')?.href || '',
    robots:       document.querySelector('meta[name="robots"]')?.content?.trim() || '',
    viewport:     document.querySelector('meta[name="viewport"]')?.content?.trim() || '',
    charset:      document.characterSet || '',
    lang:         document.documentElement.getAttribute('lang') || '',
    favicon:      (document.querySelector('link[rel~="icon"]') || {}).href || '',
    headings: [],
    links:    [],
    images:   [],
    schema:   [],
    og:       {},
    twitter:  {},
    hreflang: [],
  };

  // headings (preserve document order)
  document.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => {
    out.headings.push({
      level: Number(h.tagName[1]),
      text: (h.textContent || '').replace(/\s+/g, ' ').trim(),
    });
  });

  // links
  const origin = location.origin;
  document.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (!href || href.startsWith('javascript:') || href.startsWith('#')) return;
    let abs;
    try { abs = new URL(href, document.baseURI).href; } catch { return; }
    let internal = false;
    try { internal = new URL(abs).origin === origin; } catch {}
    out.links.push({
      url: abs,
      anchor: (a.textContent || '').replace(/\s+/g, ' ').trim(),
      rel: a.getAttribute('rel') || '',
      target: a.getAttribute('target') || '',
      internal,
    });
  });

  // assets (images + videos folded into the same array)
  const seenAsset = new Set();
  const pushAsset = (src, alt, w, h, kind, poster) => {
    if (!src) return;
    let abs;
    try { abs = new URL(src, document.baseURI).href; } catch { return; }
    if (!/^https?:|^data:|^blob:/i.test(abs)) return;
    if (seenAsset.has(abs)) return;
    seenAsset.add(abs);
    out.images.push({ src: abs, alt: (alt || '').trim(), w: w || 0, h: h || 0, kind, poster: poster || '' });
  };

  // <img>
  document.querySelectorAll('img').forEach(img => {
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    pushAsset(src, img.alt, img.naturalWidth || img.width, img.naturalHeight || img.height, 'image');
  });
  // <picture><source srcset>
  document.querySelectorAll('picture source').forEach(s => {
    const set = s.getAttribute('srcset');
    if (!set) return;
    set.split(',').forEach(p => pushAsset(p.trim().split(/\s+/)[0], '', 0, 0, 'image'));
  });
  // <svg><image>
  document.querySelectorAll('svg image').forEach(im => {
    pushAsset(im.getAttribute('href') || im.getAttribute('xlink:href'), '', 0, 0, 'image');
  });
  // CSS background-image
  let bgScanned = 0;
  for (const el of document.querySelectorAll('*')) {
    if (bgScanned > 600) break;
    bgScanned++;
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') continue;
    const re = /url\((['"]?)(.*?)\1\)/g;
    let m;
    while ((m = re.exec(bg)) !== null) pushAsset(m[2], '', 0, 0, 'image');
  }

  // <video> + <video><source> (also pull poster as a separate image asset)
  document.querySelectorAll('video').forEach(v => {
    const w = v.videoWidth || v.clientWidth || 0;
    const h = v.videoHeight || v.clientHeight || 0;
    const direct = v.currentSrc || v.src || v.getAttribute('src');
    if (direct) {
      pushAsset(direct, v.getAttribute('aria-label') || '', w, h, 'video', v.poster);
    }
    v.querySelectorAll('source').forEach(s => {
      const src = s.src || s.getAttribute('src');
      if (src) pushAsset(src, '', w, h, 'video', v.poster);
    });
    if (v.poster) pushAsset(v.poster, '', 0, 0, 'image');
  });

  // <audio> + <audio><source> (rare on SEO pages but cheap to include)
  document.querySelectorAll('audio').forEach(a => {
    const direct = a.currentSrc || a.src || a.getAttribute('src');
    if (direct) pushAsset(direct, '', 0, 0, 'audio');
    a.querySelectorAll('source').forEach(s => {
      const src = s.src || s.getAttribute('src');
      if (src) pushAsset(src, '', 0, 0, 'audio');
    });
  });

  // <iframe> video embeds — recognise common providers and synthesise a
  // canonical "watch" URL + poster image when the provider exposes one.
  // We push the watch URL (not the embed URL) so copy/open lands on the
  // viewable page, not the iframe.
  const EMBEDS = [
    { name: 'YouTube',     re: /(?:youtube\.com\/embed\/|youtu\.be\/|youtube-nocookie\.com\/embed\/)([\w-]{11})/i,
      poster: id => `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
      watch:  id => `https://www.youtube.com/watch?v=${id}` },
    { name: 'Vimeo',       re: /player\.vimeo\.com\/video\/(\d+)/i,
      poster: ()  => '',
      watch:  id => `https://vimeo.com/${id}` },
    { name: 'Loom',        re: /loom\.com\/embed\/([a-f0-9]+)/i,
      poster: id => `https://cdn.loom.com/sessions/thumbnails/${id}-with-play.gif`,
      watch:  id => `https://www.loom.com/share/${id}` },
    { name: 'Wistia',      re: /(?:fast\.wistia\.net\/embed\/iframe|fast\.wistia\.com\/embed\/medias)\/([a-z0-9]+)/i,
      poster: ()  => '',
      watch:  id => `https://wistia.com/medias/${id}` },
    { name: 'Dailymotion', re: /dailymotion\.com\/embed\/video\/([a-z0-9]+)/i,
      poster: id => `https://www.dailymotion.com/thumbnail/video/${id}`,
      watch:  id => `https://www.dailymotion.com/video/${id}` },
    { name: 'TikTok',      re: /tiktok\.com\/embed\/v?\d?\/?(\d+)/i,
      poster: ()  => '',
      watch:  id => `https://www.tiktok.com/embed/${id}` },
  ];

  document.querySelectorAll('iframe[src]').forEach(f => {
    const raw = f.getAttribute('src');
    if (!raw) return;
    let abs;
    try { abs = new URL(raw, document.baseURI).href; } catch { return; }
    for (const p of EMBEDS) {
      const m = abs.match(p.re);
      if (!m) continue;
      const id    = m[1];
      const watch = p.watch(id);
      if (seenAsset.has(watch)) break;
      seenAsset.add(watch);
      out.images.push({
        src: watch,
        alt: (f.title || f.getAttribute('aria-label') || '').trim(),
        w: f.clientWidth  || 0,
        h: f.clientHeight || 0,
        kind: 'embed',
        poster: p.poster(id),
        provider: p.name,
      });
      break;
    }
  });

  // JSON-LD schema
  document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
    try {
      const parsed = JSON.parse(s.textContent || '');
      out.schema.push(parsed);
    } catch { /* ignore malformed */ }
  });

  // og: + twitter: meta
  document.querySelectorAll('meta[property^="og:"], meta[property^="article:"], meta[property^="profile:"]').forEach(m => {
    const k = m.getAttribute('property');
    const v = m.getAttribute('content');
    if (k && v != null) out.og[k] = v;
  });
  document.querySelectorAll('meta[name^="twitter:"]').forEach(m => {
    const k = m.getAttribute('name');
    const v = m.getAttribute('content');
    if (k && v != null) out.twitter[k] = v;
  });

  // hreflang
  document.querySelectorAll('link[rel="alternate"][hreflang]').forEach(l => {
    out.hreflang.push({ lang: l.getAttribute('hreflang'), href: l.href });
  });

  return out;
}

// ---------- nav ----------
function bindNav() {
  $('#nav').addEventListener('click', e => {
    const a = e.target.closest('a[data-tab]');
    if (!a) return;
    e.preventDefault();
    showTab(a.dataset.tab);
  });
}

function showTab(name) {
  state.tab = name;
  $$('#nav a').forEach(a => {
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $$('.tab').forEach(t => { t.hidden = true; });
  const panel = document.getElementById('tab-' + name);
  if (panel) panel.hidden = false;
}

// ---------- shared helpers ----------
const elt = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const fmtSize = b => {
  if (!b) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10 * 1024 ? 1 : 0) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
};
const fmtTotal = b => {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
};

const ICONS = {
  title:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m4 12 8-9 8 9"/><path d="M12 3v18"/></svg>`,
  desc:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
  link:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>`,
  canon:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>`,
  robot:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>`,
  globe:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`,
  copy:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  open:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>`,
  check:    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>`,
  warn:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`,
};

function fieldRow(icon, label, valueHTML, badgeHTML = '', copyText = null) {
  const inlineCopy = (copyText != null && copyText !== '')
    ? copyBtn(copyText, `Copy ${label.toLowerCase()}`, 'inline')
    : '';
  return `
    <div class="field">
      <div class="label"><span class="ico">${icon}</span>${escapeHtml(label)}</div>
      <div class="row-actions">${badgeHTML || ''}</div>
      <div class="value ${valueHTML ? '' : 'muted'}">${valueHTML || 'Not set'}${inlineCopy}</div>
    </div>`;
}

// ---------- mini-button helpers ----------
function copyBtn(text, ariaLabel = 'Copy', cls = '') {
  // store payload via data-copy attribute (escape carefully)
  const payload = String(text)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<button type="button" class="mini ${cls}" data-act="copy-text" data-copy="${payload}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(ariaLabel)}">${ICONS.copy}<span class="sr-only">${escapeHtml(ariaLabel)}</span></button>`;
}

function dlBtn(url, filename, ariaLabel = 'Download', cls = '') {
  return `<button type="button" class="mini ${cls}" data-act="dl-url" data-url="${escapeHtml(url)}" data-filename="${escapeHtml(filename || '')}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(ariaLabel)}">${ICONS.download}<span class="sr-only">${escapeHtml(ariaLabel)}</span></button>`;
}

function openBtn(url, ariaLabel = 'Open in new tab', cls = '') {
  return `<button type="button" class="mini ${cls}" data-act="open-url" data-url="${escapeHtml(url)}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(ariaLabel)}">${ICONS.open}<span class="sr-only">${escapeHtml(ariaLabel)}</span></button>`;
}

// SEO length thresholds based on Google SERP rendering:
//   title       — sweet spot 30–60 chars (warn under 30, warn over 60)
//   description — sweet spot 70–160 chars (warn under 70, warn over 160)
function lengthBadge(len, { min, max, soft }) {
  if (len === 0)    return `<span class="badge warn">${ICONS.warn} Missing</span>`;
  if (len < min)    return `<span class="badge warn">${ICONS.warn} ${len} chars · too short</span>`;
  if (len <= max)   return `<span class="badge ok">${ICONS.check} ${len} chars</span>`;
  if (len <= soft)  return `<span class="badge info">${len} chars · long</span>`;
  return `<span class="badge warn">${ICONS.warn} ${len} chars · too long</span>`;
}

// =============================================================
// OVERVIEW
// =============================================================
function renderOverview() {
  const d = state.data;
  const titleLen = d.title.length;
  const descLen  = d.description.length;
  const canonOk  = d.canonical && (d.canonical === d.url || d.canonical === d.finalUrl);

  $('#tab-overview').innerHTML = `
    <div class="fields">
      ${fieldRow(ICONS.title, 'Title',       escapeHtml(d.title),       lengthBadge(titleLen, { min: 30, max: 60,  soft: 70  }), d.title)}
      ${fieldRow(ICONS.desc,  'Description', escapeHtml(d.description), lengthBadge(descLen,  { min: 70, max: 160, soft: 175 }), d.description)}
      ${fieldRow(ICONS.link,  'URL', escapeHtml(d.url), '', d.url)}
      ${fieldRow(ICONS.canon, 'Canonical',
        d.canonical
          ? `<a href="${escapeHtml(d.canonical)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escapeHtml(d.canonical)}</a>`
          : '',
        canonOk
          ? `<span class="badge ok">${ICONS.check} Self-referencing</span>`
          : (d.canonical ? `<span class="badge info">External</span>` : `<span class="badge muted">None</span>`),
        d.canonical
      )}
      ${fieldRow(ICONS.robot, 'Robots', escapeHtml(d.robots) || '<span class="muted">Default (index, follow)</span>',
        /noindex/i.test(d.robots) ? `<span class="badge warn">${ICONS.warn} noindex</span>` : '',
        d.robots
      )}
      ${fieldRow(ICONS.globe, 'Language', escapeHtml(d.lang) || '',
        d.lang ? `<span class="badge muted">${escapeHtml(d.lang)}</span>` : `<span class="badge warn">${ICONS.warn} No lang attr</span>`,
        d.lang
      )}
    </div>`;
}

// =============================================================
// HEADINGS
// =============================================================
function renderHeadings() {
  const d = state.data;
  const counts = [0, 0, 0, 0, 0, 0, 0]; // index 0 unused
  d.headings.forEach(h => counts[h.level]++);
  const h1Count = counts[1];

  let summary = `<div class="summary">`;
  for (let i = 1; i <= 6; i++) {
    const warn = i === 1 && h1Count !== 1;
    summary += `<div class="stat"><span class="k">${counts[i]}</span><span class="v ${warn ? 'warn' : ''}">H${i}</span></div>`;
  }
  summary += `<div class="stat"><span class="k">${d.images.length}</span><span class="v">Images</span></div>`;
  summary += `<div class="stat"><span class="k">${d.links.length}</span><span class="v">Links</span></div>`;
  summary += `</div>`;

  let rows = '';
  if (d.headings.length === 0) {
    rows = `<div class="empty"><span class="em">No headings.</span>This page has no h1–h6 tags.</div>`;
  } else {
    rows = `<div class="headings">`;
    d.headings.forEach(h => {
      const indent = Math.max(0, h.level - 1);
      const empty = !h.text;
      const inlineCopy = empty ? '' : copyBtn(h.text, `Copy H${h.level} text`, 'inline');
      rows += `<div class="heading lvl-${h.level} ${empty ? 'empty' : ''}" data-indent="${indent}">
        <span class="tag">H${h.level}</span>
        <span class="text">${empty ? 'Empty heading' : escapeHtml(h.text)}${inlineCopy}</span>
        <span></span>
      </div>`;
    });
    rows += `</div>`;
  }

  $('#tab-headings').innerHTML = summary + rows;
}

// =============================================================
// LINKS
// =============================================================
function renderLinks() {
  const d = state.data;
  const internal = d.links.filter(l => l.internal);
  const external = d.links.filter(l => !l.internal);
  const unique   = new Set(d.links.map(l => l.url)).size;

  const filterChips = `
    <div class="linkfilter">
      <button class="chip" data-lf="ALL"      aria-pressed="${state.linkFilter==='ALL'}" type="button">All <span class="count">${d.links.length}</span></button>
      <button class="chip" data-lf="INTERNAL" aria-pressed="${state.linkFilter==='INTERNAL'}" type="button"><span class="dot"></span>Internal <span class="count">${internal.length}</span></button>
      <button class="chip" data-lf="EXTERNAL" aria-pressed="${state.linkFilter==='EXTERNAL'}" type="button"><span class="dot"></span>External <span class="count">${external.length}</span></button>
      <span style="flex:1"></span>
      <span class="badge muted" style="align-self:center">${unique} unique</span>
    </div>`;

  const items = state.linkFilter === 'INTERNAL' ? internal
              : state.linkFilter === 'EXTERNAL' ? external
              : d.links;

  let body = '';
  if (items.length === 0) {
    body = `<div class="empty"><span class="em">No links.</span>Nothing here for this filter.</div>`;
  } else {
    body = `<div class="links">`;
    items.forEach(l => {
      const tags = [];
      if (l.rel) l.rel.split(/\s+/).forEach(r => tags.push(`<span class="badge muted">${escapeHtml(r)}</span>`));
      if (l.target === '_blank') tags.push(`<span class="badge info">_blank</span>`);
      body += `
        <div class="linkrow">
          <span class="anchor ${l.anchor ? '' : 'empty'}">${l.anchor ? escapeHtml(l.anchor) : 'No anchor text'}</span>
          <span class="meta-tags">${tags.join('')}</span>
          <span class="url"><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.url)}</a>${copyBtn(l.url, 'Copy link URL', 'inline')}${openBtn(l.url, 'Open link', 'inline')}</span>
        </div>`;
    });
    body += `</div>`;
  }

  $('#tab-links').innerHTML = filterChips + body;

  // bind chip clicks
  $('#tab-links').querySelectorAll('[data-lf]').forEach(c => {
    c.addEventListener('click', () => {
      state.linkFilter = c.dataset.lf;
      renderLinks();
    });
  });
}

// =============================================================
// IMAGES (existing functionality, ported into the new shell)
// =============================================================
function renderImages() {
  const imgs = state.data.images;

  if (imgs.length === 0) {
    $('#tab-images').innerHTML = `<div class="empty"><span class="em">No assets.</span>This page contains no images, videos, or CSS background media.</div>`;
    return;
  }

  // ensure each asset has type/name/bytes (kind is set during scrape)
  imgs.forEach(i => {
    if (!i.kind) i.kind = 'image';
    if (!i.type) {
      if (i.kind === 'embed' && i.provider) {
        i.type = i.provider.toUpperCase();
        i.name = `${i.provider} video`;
      } else {
        const parsed = parseImgUrl(i.src);
        i.name = parsed.name;
        i.type = parsed.type;
      }
      i.bytes = i.bytes || 0;
    }
  });

  const counts = {};
  for (const i of imgs) counts[i.type] = (counts[i.type] || 0) + 1;
  const types = Object.keys(counts).sort();

  let chips = `<button class="chip" data-it="ALL" aria-pressed="${state.imgTypes.has('ALL')}" type="button">All <span class="count">${imgs.length}</span></button>`;
  for (const t of types) {
    chips += `<button class="chip" data-it="${escapeHtml(t)}" aria-pressed="${state.imgTypes.has(t)}" type="button"><span class="dot"></span>${escapeHtml(t)} <span class="count">${counts[t]}</span></button>`;
  }

  const visible = state.imgTypes.has('ALL') ? imgs : imgs.filter(i => state.imgTypes.has(i.type));
  const totalBytes = visible.reduce((s, i) => s + (i.bytes || 0), 0);
  // missing-alt only applies to images, not videos/audio/embeds
  const missing = visible.filter(i => i.kind === 'image' && !i.alt).length;
  const videoCount = visible.filter(i => i.kind === 'video').length;
  const embedCount = visible.filter(i => i.kind === 'embed').length;

  let body = '';
  if (visible.length === 0) {
    body = `<div class="empty"><span class="em">Nothing matches.</span>Try a different file-type filter.</div>`;
  } else if (state.imgView === 'list') {
    body = `<ul class="list">`;
    visible.forEach(img => {
      const idx = imgs.indexOf(img);
      body += `<li class="row" data-i="${idx}">${imgThumbHTML(img)}${imgMetaHTML(img)}${imgActionsHTML(idx, 'list')}</li>`;
    });
    body += `</ul>`;
  } else {
    body = `<div class="grid">`;
    visible.forEach(img => {
      const idx = imgs.indexOf(img);
      body += `<div class="card" data-i="${idx}">${imgThumbHTML(img)}${imgMetaHTML(img)}${imgActionsHTML(idx, 'grid')}</div>`;
    });
    body += `</div>`;
  }

  $('#tab-images').innerHTML = `
    <header class="header">
      <div>
        <h1>Page <em>assets</em></h1>
        <div class="sub">
          <b>${visible.length}</b> of <b>${imgs.length}</b> assets
          ${videoCount ? `<span class="sep">·</span><b>${videoCount}</b> video${videoCount === 1 ? '' : 's'}` : ''}
          ${embedCount ? `<span class="sep">·</span><b>${embedCount}</b> embed${embedCount === 1 ? '' : 's'}` : ''}
          <span class="sep">·</span>
          <b>${totalBytes ? fmtTotal(totalBytes) : '—'}</b> total
          <span class="sep">·</span>
          <b style="color: var(--warn)">${missing}</b> img${missing === 1 ? '' : 's'} missing alt
        </div>
      </div>
      <button class="download-all" id="downloadAll" type="button" title="Download all visible images">
        ${ICONS.download} Download all
      </button>
    </header>
    <div class="toolbar" role="toolbar" aria-label="Filter and view options">
      <div class="chips" id="imgChips" role="group" aria-label="Filter by file type">${chips}</div>
      <div class="view-toggle" role="group" aria-label="View">
        <button id="viewList" aria-pressed="${state.imgView==='list'}" aria-label="List" title="List">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>
        </button>
        <button id="viewGrid" aria-pressed="${state.imgView==='grid'}" aria-label="Grid" title="Grid">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        </button>
      </div>
    </div>
    ${body}
  `;

  // bindings
  $('#tab-images').querySelectorAll('#imgChips .chip').forEach(c => {
    c.addEventListener('click', () => {
      const t = c.dataset.it;
      if (t === 'ALL') state.imgTypes = new Set(['ALL']);
      else {
        state.imgTypes.delete('ALL');
        if (state.imgTypes.has(t)) state.imgTypes.delete(t);
        else state.imgTypes.add(t);
        if (state.imgTypes.size === 0) state.imgTypes = new Set(['ALL']);
      }
      renderImages();
    });
  });
  $('#viewList').addEventListener('click', () => { state.imgView = 'list'; renderImages(); });
  $('#viewGrid').addEventListener('click', () => { state.imgView = 'grid'; renderImages(); });
  $('#downloadAll').addEventListener('click', () => {
    // skip embeds (would download the iframe HTML, not the video)
    visible.filter(i => !i.broken && i.kind !== 'embed').forEach((img, k) => setTimeout(() => downloadImg(img), k * 150));
  });

  // mark broken thumbs
  $('#tab-images').querySelectorAll('[data-thumb]').forEach(el => {
    el.addEventListener('error', () => {
      const wrap = el.parentElement;
      if (!wrap) return;
      wrap.classList.add('broken');
      wrap.innerHTML = ICONS.brokenImg || `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11"/><path d="m21 21-6-6"/><path d="m15 21 6-6"/></svg>`;
      const i = Number(wrap.closest('[data-i]')?.dataset.i);
      if (imgs[i]) imgs[i].broken = true;
    }, { once: true });
  });
}

function parseImgUrl(src) {
  let name = '', type = 'OTHER';
  if (src.startsWith('data:')) {
    const m = src.match(/^data:image\/([a-z0-9+.-]+)/i);
    type = (m?.[1] || 'data').toUpperCase().replace('SVG+XML', 'SVG').replace('JPEG', 'JPG');
    return { name: `inline.${type.toLowerCase()}`, type };
  }
  try {
    const u = new URL(src);
    name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    const m = u.pathname.match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
    type = m ? m[1].toUpperCase().replace('JPEG', 'JPG').replace('SVG+XML', 'SVG') : 'IMG';
  } catch {}
  return { name: name || 'image', type };
}

function imgThumbHTML(img) {
  if (img.broken) {
    return `<div class="thumb broken" title="Asset failed to load">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11"/><path d="m21 21-6-6"/><path d="m15 21 6-6"/></svg>
    </div>`;
  }
  if (img.kind === 'video') {
    // Prefer the poster image (no decode cost). Fall back to the video itself
    // with preload=metadata so the browser pulls just enough to render frame 1.
    const inner = img.poster
      ? `<img src="${escapeHtml(img.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-thumb>`
      : `<video src="${escapeHtml(img.src)}" muted playsinline preload="metadata" referrerpolicy="no-referrer" data-thumb></video>`;
    return `<div class="thumb media">${inner}<span class="play-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span></div>`;
  }
  if (img.kind === 'embed') {
    const inner = img.poster
      ? `<img src="${escapeHtml(img.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-thumb>`
      : `<div class="provider-tile">${escapeHtml(img.provider || 'Embed')}</div>`;
    return `<div class="thumb media">${inner}<span class="play-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span></div>`;
  }
  if (img.kind === 'audio') {
    return `<div class="thumb media audio" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
    </div>`;
  }
  return `<div class="thumb"><img src="${escapeHtml(img.src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-thumb></div>`;
}
function imgMetaHTML(img) {
  const isEmbed = img.kind === 'embed';
  const isMedia = img.kind !== 'image';
  // alt only meaningful for images; for embeds show iframe title or "Untitled"
  let altLine;
  if (isEmbed) {
    altLine = `<div class="alt">${img.alt ? escapeHtml(img.alt) : '<span class="muted">No iframe title</span>'}</div>`;
  } else if (isMedia) {
    altLine = `<div class="alt muted">${img.kind === 'video' ? 'Video file' : 'Audio file'}</div>`;
  } else if (img.alt) {
    altLine = `<div class="alt" title="${escapeHtml(img.alt)}">${escapeHtml(img.alt)}</div>`;
  } else {
    altLine = `<div class="alt missing">${ICONS.warn}Missing alt text</div>`;
  }
  const dims = (img.w && img.h) ? `<span>${img.w}&thinsp;×&thinsp;${img.h}</span>` : '';
  const sizeCell = isEmbed ? '' : (dims ? `<span class="sep"></span>` : '') + `<span data-size>${fmtSize(img.bytes)}</span>`;
  return `
    <div class="meta">
      <div class="filename" title="${escapeHtml(img.src)}">${escapeHtml(img.name)}</div>
      ${altLine}
      <div class="specs">
        <span class="tag">${escapeHtml(img.type)}</span>
        ${dims}
        ${sizeCell}
      </div>
    </div>`;
}
function imgActionsHTML(idx, variant) {
  const img = state.data.images[idx];
  const wrap = variant === 'grid' ? 'card-actions' : 'actions';
  const isEmbed = img && img.kind === 'embed';
  const copy = variant === 'grid' ? '' : `<button class="icon-btn" title="${isEmbed ? 'Copy watch URL' : 'Copy'}" data-act="img-copy" data-i="${idx}" type="button">${ICONS.copy}</button>`;
  const dl   = isEmbed ? '' : `<button class="icon-btn primary" title="Download" data-act="img-dl" data-i="${idx}" type="button">${ICONS.download}</button>`;
  return `
    <div class="${wrap}">
      ${copy}
      <button class="icon-btn ${isEmbed ? 'primary' : ''}" title="Open in new tab" data-act="img-open" data-i="${idx}" type="button">${ICONS.open}</button>
      ${dl}
    </div>`;
}

function downloadImg(img) {
  chrome.downloads.download({
    url: img.src,
    filename: (img.name || 'image').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180),
    saveAs: false,
  }).catch(() => {});
}

async function hydrateImageSizes() {
  const imgs = state.data.images;
  // skip data:/blob: URIs and iframe embeds (HEAD on an HTML page is noise)
  const queue = imgs.filter(i =>
    !i.bytes && !i.src.startsWith('data:') && !i.src.startsWith('blob:') && i.kind !== 'embed'
  );
  let active = 0;
  const max = 6;

  await new Promise(resolve => {
    if (queue.length === 0) return resolve();
    const next = () => {
      while (active < max && queue.length) {
        const img = queue.shift();
        active++;
        fetchSize(img.src).then(b => {
          if (b != null) {
            img.bytes = b;
            const node = document.querySelector(`#tab-images [data-i="${imgs.indexOf(img)}"] [data-size]`);
            if (node) node.textContent = fmtSize(b);
          }
        }).catch(() => {}).finally(() => {
          active--;
          if (queue.length === 0 && active === 0) resolve();
          else next();
        });
      }
    };
    next();
  });

  // refresh totals if Images tab is currently visible
  if (state.tab === 'images') {
    const visible = state.imgTypes.has('ALL') ? imgs : imgs.filter(i => state.imgTypes.has(i.type));
    const totalBytes = visible.reduce((s, i) => s + (i.bytes || 0), 0);
    const sub = $('#tab-images .header .sub');
    if (sub) {
      const bs = sub.querySelectorAll('b');
      if (bs[2]) bs[2].textContent = totalBytes ? fmtTotal(totalBytes) : '—';
    }
  }
}

async function fetchSize(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!r.ok) return null;
    const len = r.headers.get('content-length');
    return len ? Number(len) : null;
  } catch { return null; }
}

// =============================================================
// SCHEMA
// =============================================================
function renderSchema() {
  const docs = state.data.schema;

  if (docs.length === 0) {
    $('#tab-schema').innerHTML = `<div class="empty"><span class="em">No structured data.</span>This page has no JSON-LD schema.</div>`;
    return;
  }

  // flatten @graph entries to top-level docs
  const flat = [];
  docs.forEach((d, di) => {
    if (Array.isArray(d)) d.forEach(item => flat.push({ item, src: `script #${di + 1}` }));
    else if (d && Array.isArray(d['@graph'])) d['@graph'].forEach(item => flat.push({ item, src: `script #${di + 1} @graph` }));
    else flat.push({ item: d, src: `script #${di + 1}` });
  });

  const typeOf = (v) => {
    const t = v?.['@type'];
    if (Array.isArray(t)) return t.join('·');
    if (t) return String(t);
    return Array.isArray(v) ? `Array(${v.length})` : 'Object';
  };
  const labelFor = (v) => v?.name || v?.headline || v?.['@id'] || v?.url || '';

  const primVal = (val) => {
    const s = val == null ? 'null' : String(val);
    const isUrl = /^https?:\/\//i.test(s);
    return isUrl
      ? `<a class="sv url" href="${escapeHtml(s)}" target="_blank" rel="noopener" title="${escapeHtml(s)}">${escapeHtml(s)}</a>`
      : `<span class="sv">${escapeHtml(s)}</span>`;
  };

  const renderRow = (key, val) => {
    if (val !== null && typeof val === 'object') {
      const isArr = Array.isArray(val);
      if (isArr && val.length && val.every(v => typeof v !== 'object')) {
        return `<div class="srow leaf"><span class="sk">${escapeHtml(key)}</span>${primVal(val.join(', '))}</div>`;
      }
      if (isArr && val.length === 0) {
        return `<div class="srow leaf"><span class="sk">${escapeHtml(key)}</span><span class="sv muted">[ ]</span></div>`;
      }
      const entries = isArr ? val.map((v, i) => [`[${i}]`, v]) : Object.entries(val);
      if (entries.length === 0) {
        return `<div class="srow leaf"><span class="sk">${escapeHtml(key)}</span><span class="sv muted">{ }</span></div>`;
      }
      const tag = isArr ? `Array(${val.length})` : typeOf(val);
      const lbl = !isArr ? labelFor(val) : '';
      const meta = lbl ? `${tag} · ${lbl}` : tag;
      return `<details class="snode"><summary class="srow"><span class="schev"></span><span class="sk">${escapeHtml(key)}</span><span class="stag">${escapeHtml(meta)}</span></summary><div class="skids">${entries.map(([k, v]) => renderRow(k, v)).join('')}</div></details>`;
    }
    return `<div class="srow leaf"><span class="sk">${escapeHtml(key)}</span>${primVal(val)}</div>`;
  };

  let body = `<div class="schema">`;
  flat.forEach(({ item, src }, idx) => {
    const tag = typeOf(item);
    const lbl = labelFor(item);
    const json = JSON.stringify(item, null, 2);
    const entries = Object.entries(item || {});
    const open = idx === 0 ? ' open' : '';
    body += `<details class="sdoc"${open}>
      <summary class="sdoc-head">
        <span class="schev"></span>
        <span class="sdoc-type">${escapeHtml(tag)}</span>
        ${lbl ? `<span class="sdoc-name">${escapeHtml(lbl)}</span>` : ''}
        <span class="sdoc-spacer"></span>
        <span class="sdoc-src">${escapeHtml(src)}</span>
        ${copyBtn(json, 'Copy JSON', 'always')}
      </summary>
      <div class="sdoc-body">${entries.map(([k, v]) => renderRow(k, v)).join('')}</div>
    </details>`;
  });
  body += `</div>`;

  $('#tab-schema').innerHTML = body;
}

// =============================================================
// SOCIAL
// =============================================================
function renderSocial() {
  const og = state.data.og;
  const tw = state.data.twitter;

  const ogKeys = Object.keys(og);
  const twKeys = Object.keys(tw);

  if (ogKeys.length === 0 && twKeys.length === 0) {
    $('#tab-social').innerHTML = `<div class="empty"><span class="em">No social tags.</span>No Open Graph or Twitter meta tags were found.</div>`;
    return;
  }

  const renderGroup = (title, badge, obj) => {
    const keys = Object.keys(obj);
    if (keys.length === 0) return '';
    let html = `<div class="field" style="grid-template-columns:1fr;border-top:1px solid var(--line-2);padding-bottom:6px">
      <div class="label" style="justify-content:space-between">
        <span style="display:inline-flex;gap:9px;align-items:center"><span class="ico">${ICONS.globe}</span>${escapeHtml(title)}</span>
        <span class="badge ${badge}">${keys.length}</span>
      </div>
    </div>`;
    keys.sort().forEach(k => {
      const v = obj[k];
      const isUrl = /^https?:\/\//i.test(v);
      const isImg = /image$/i.test(k) && isUrl;
      const valueText = isUrl
        ? `<a href="${escapeHtml(v)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escapeHtml(v)}</a>`
        : escapeHtml(v);
      const inlineCopy = copyBtn(v, `Copy ${k}`, 'inline');
      const dlAction   = isImg ? dlBtn(v, k.replace(/[:]/g, '_') + '.img', `Download ${k}`, 'inline') : '';
      html += `<div class="field" style="grid-template-columns:1fr;padding-top:8px;padding-bottom:8px">
        <div class="label" style="font-weight:500;font-size:12px;color:var(--muted);font-family:'JetBrains Mono',monospace">${escapeHtml(k)}</div>
        <div class="value prose" style="grid-column:1;display:flex;gap:10px;align-items:flex-start">
          ${isImg ? `<img src="${escapeHtml(v)}" alt="" referrerpolicy="no-referrer" loading="lazy" style="width:64px;height:48px;object-fit:cover;border-radius:6px;border:1px solid var(--line);flex-shrink:0">` : ''}
          <span style="min-width:0;flex:1;word-break:break-word">${valueText}${inlineCopy}${dlAction}</span>
        </div>
      </div>`;
    });
    return html;
  };

  $('#tab-social').innerHTML = `<div class="fields">
    ${renderGroup('Open Graph', 'info', og)}
    ${renderGroup('Twitter Card', 'info', tw)}
  </div>`;
}

// =============================================================
// ADVANCED
// =============================================================
function renderAdvanced() {
  const d = state.data;

  let hreflang = '';
  if (d.hreflang.length) {
    hreflang = `<div class="value prose">${d.hreflang.map(h => `<div><b style="color:var(--ink);font-weight:600">${escapeHtml(h.lang)}</b> → <a href="${escapeHtml(h.href)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escapeHtml(h.href)}</a></div>`).join('')}</div>`;
  }

  const robotsUrl  = originOf(d.url) + '/robots.txt';
  const sitemapUrl = originOf(d.url) + '/sitemap.xml';

  $('#tab-advanced').innerHTML = `
    <div class="fields">
      ${fieldRow(ICONS.globe, 'Viewport', escapeHtml(d.viewport), d.viewport ? '' : `<span class="badge warn">${ICONS.warn} Missing</span>`, d.viewport)}
      ${fieldRow(ICONS.globe, 'Charset',  escapeHtml(d.charset), '', d.charset)}
      ${fieldRow(ICONS.globe, 'Favicon',
        d.favicon ? `<a href="${escapeHtml(d.favicon)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escapeHtml(d.favicon)}</a>` : '',
        d.favicon ? '' : `<span class="badge warn">${ICONS.warn} Missing</span>`,
        d.favicon
      )}
      <div class="field">
        <div class="label"><span class="ico">${ICONS.globe}</span>Hreflang</div>
        <div class="row-actions"><span class="badge ${d.hreflang.length ? 'info' : 'muted'}">${d.hreflang.length || 'None'}</span></div>
        ${hreflang || '<div class="value muted">No hreflang alternates.</div>'}
      </div>
      <div class="field">
        <div class="label"><span class="ico">${ICONS.link}</span>Robots.txt</div>
        <div class="row-actions">${openBtn(robotsUrl, 'Open robots.txt', 'always')}${dlBtn(robotsUrl, 'robots.txt', 'Download robots.txt', 'always')}</div>
        <div class="value">${escapeHtml(robotsUrl)}</div>
      </div>
      <div class="field">
        <div class="label"><span class="ico">${ICONS.link}</span>Sitemap.xml</div>
        <div class="row-actions">${openBtn(sitemapUrl, 'Open sitemap.xml', 'always')}${dlBtn(sitemapUrl, 'sitemap.xml', 'Download sitemap.xml', 'always')}</div>
        <div class="value">${escapeHtml(sitemapUrl)}</div>
      </div>
    </div>`;
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

// =============================================================
// Delegated actions (image actions)
// =============================================================
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  // prevent <summary> toggle when clicking action buttons inside it
  if (btn.closest('summary')) e.preventDefault();
  const act = btn.dataset.act;

  // generic copy
  if (act === 'copy-text') {
    const text = btn.dataset.copy ?? '';
    try { await navigator.clipboard.writeText(text); flashSuccess(btn, 'Copied'); }
    catch { flash(btn, 'Failed'); }
    return;
  }
  // generic download by URL
  if (act === 'dl-url') {
    const url = btn.dataset.url;
    const filename = btn.dataset.filename || guessFilename(url);
    if (url) chrome.downloads.download({ url, filename: safeFilename(filename), saveAs: false }).catch(() => {});
    flashSuccess(btn, 'Downloading');
    return;
  }
  // generic open in tab
  if (act === 'open-url') {
    const url = btn.dataset.url;
    if (url) chrome.tabs.create({ url });
    return;
  }

  // image-row actions
  const i = Number(btn.dataset.i);
  const img = state.data?.images?.[i];
  if (!img) return;
  if (act === 'img-copy') {
    if (img.kind !== 'image') {
      // clipboards don't accept video/audio bitmaps — copy the URL instead
      try { await navigator.clipboard.writeText(img.src); flashSuccess(btn, 'Copied URL'); }
      catch { flash(btn, 'Failed'); }
    } else {
      flash(btn, 'Copying…');
      try {
        await copyImageBitmap(img.src);
        flashSuccess(btn, 'Copied image');
      } catch {
        try { await navigator.clipboard.writeText(img.src); flashSuccess(btn, 'Copied URL'); }
        catch { flash(btn, 'Failed'); }
      }
    }
  } else if (act === 'img-open') {
    chrome.tabs.create({ url: img.src });
  } else if (act === 'img-dl') {
    downloadImg(img);
    flashSuccess(btn, 'Downloading');
  }
});

function flashSuccess(el, msg) {
  const originalTitle = el.getAttribute('title') || el.getAttribute('aria-label') || '';
  const originalHTML  = el.innerHTML;
  el.classList.add('ok');
  el.innerHTML = `${ICONS.check}<span class="sr-only">${escapeHtml(msg)}</span>`;
  el.setAttribute('title', msg);
  el.setAttribute('aria-label', msg);
  setTimeout(() => {
    el.classList.remove('ok');
    el.innerHTML = originalHTML;
    el.setAttribute('title', originalTitle);
    el.setAttribute('aria-label', originalTitle);
  }, 1100);
}

function safeFilename(n) {
  return String(n || 'file').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180) || 'file';
}

// Copy an image to the system clipboard as a real bitmap (so it can be pasted
// into Figma, Slack, mail clients, etc — not just as a URL string).
//
// Strategy:
//   1. Fetch the bytes (extension has <all_urls> host permission, so cross-
//      origin works without CORS gymnastics).
//   2. If it's already PNG, write it directly via ClipboardItem.
//   3. Otherwise (JPG/WebP/AVIF/SVG/data:), decode → draw to a canvas →
//      re-encode as PNG. Most OSes only accept image/png on the clipboard.
async function copyImageBitmap(src) {
  const resp = await fetch(src, { credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();

  if (blob.type === 'image/png') {
    return navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }

  // Decode → re-encode as PNG via OffscreenCanvas (or HTMLCanvas fallback).
  const objUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload  = () => resolve(i);
      i.onerror = () => reject(new Error('Image decode failed'));
      i.crossOrigin = 'anonymous';
      i.src = objUrl;
    });
    const w = img.naturalWidth  || img.width  || 1;
    const h = img.naturalHeight || img.height || 1;

    let pngBlob;
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      pngBlob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      if (!pngBlob) throw new Error('Canvas encode failed');
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

function guessFilename(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
  } catch { return 'file'; }
}

function flash(el, msg) {
  el.setAttribute('title', msg);
  el.setAttribute('aria-label', msg);
  el.style.transform = 'scale(0.92)';
  setTimeout(() => { el.style.transform = ''; }, 600);
}

function showError(msg) {
  $('#loading').hidden = true;
  $('#error').hidden = false;
  if (msg) $('#errorMsg').textContent = msg;
}
