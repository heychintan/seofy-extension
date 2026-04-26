// popup.js — runs in the extension popup context
// Scrapes images from the active tab via chrome.scripting.executeScript,
// then renders/filters/downloads them locally.

const $ = sel => document.querySelector(sel);

const state = {
  images: [],          // [{src, name, type, w, h, bytes, alt, broken?}]
  types:  new Set(['ALL']),
  view:   'list',
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
      func: scrapeImages,
    });
  } catch (e) {
    return showError(e.message);
  }

  const raw = results?.[0]?.result || [];
  state.images = dedupe(raw);

  $('#loading').hidden = true;

  if (state.images.length === 0) {
    $('#none').hidden = false;
    $('#totalCount').textContent = '0';
    $('#visibleCount').textContent = '0';
    $('#totalSize').textContent = '0 KB';
    $('#missingAlt').textContent = '0';
    return;
  }

  buildChips();
  bindControls();
  render();

  // Async: HEAD-fetch byte sizes we don't have yet, update rows in place.
  hydrateSizes();
}

// ---------- in-page scraper (runs in tab context) ----------
function scrapeImages() {
  const out = [];
  const seen = new Set();

  const push = (src, alt, w, h, source) => {
    if (!src) return;
    let abs;
    try { abs = new URL(src, document.baseURI).href; } catch { return; }
    if (!/^https?:|^data:/i.test(abs)) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ src: abs, alt: (alt || '').trim(), w: w || 0, h: h || 0, source });
  };

  // <img> elements (incl. lazy-loaded variants)
  document.querySelectorAll('img').forEach(img => {
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original');
    push(src, img.alt, img.naturalWidth || img.width, img.naturalHeight || img.height, 'img');
  });

  // <picture><source srcset>
  document.querySelectorAll('picture source').forEach(s => {
    const set = s.getAttribute('srcset');
    if (!set) return;
    set.split(',').forEach(part => {
      const url = part.trim().split(/\s+/)[0];
      push(url, '', 0, 0, 'source');
    });
  });

  // SVG <image href>
  document.querySelectorAll('svg image').forEach(im => {
    const src = im.getAttribute('href') || im.getAttribute('xlink:href');
    push(src, '', 0, 0, 'svg-image');
  });

  // CSS background-image on visible-ish elements (cap to avoid huge pages)
  let bgScanned = 0;
  for (const el of document.querySelectorAll('*')) {
    if (bgScanned > 600) break;
    bgScanned++;
    const cs = getComputedStyle(el);
    const bg = cs.backgroundImage;
    if (!bg || bg === 'none') continue;
    const re = /url\((['"]?)(.*?)\1\)/g;
    let m;
    while ((m = re.exec(bg)) !== null) push(m[2], '', 0, 0, 'css-bg');
  }

  return out;
}

// ---------- helpers ----------
function dedupe(items) {
  const map = new Map();
  for (const it of items) {
    const existing = map.get(it.src);
    if (!existing) {
      map.set(it.src, enrich(it));
    } else if (!existing.alt && it.alt) {
      existing.alt = it.alt;
    }
  }
  return [...map.values()];
}

function enrich(it) {
  const { name, type } = parseUrl(it.src);
  return { ...it, name, type, bytes: 0, broken: false };
}

function parseUrl(src) {
  let name = '';
  let type = 'OTHER';
  if (src.startsWith('data:')) {
    const m = src.match(/^data:image\/([a-z0-9+.-]+)/i);
    type = (m?.[1] || 'data').toUpperCase().replace('SVG+XML', 'SVG').replace('JPEG', 'JPG');
    name = `inline.${type.toLowerCase()}`;
    return { name, type };
  }
  try {
    const u = new URL(src);
    const path = u.pathname;
    name = decodeURIComponent(path.split('/').filter(Boolean).pop() || u.hostname);
    const extMatch = path.match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
    if (extMatch) {
      type = extMatch[1].toUpperCase().replace('JPEG', 'JPG').replace('SVG+XML', 'SVG');
    } else {
      // No extension — guess from query or default
      type = 'IMG';
    }
  } catch { /* keep defaults */ }
  if (!name) name = 'image';
  return { name, type };
}

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
const elt = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

// ---------- chips ----------
function buildChips() {
  const counts = {};
  for (const i of state.images) counts[i.type] = (counts[i.type] || 0) + 1;
  const types = Object.keys(counts).sort();

  const chips = $('#chips');
  chips.innerHTML = '';

  const all = elt('button', 'chip', `All <span class="count">${state.images.length}</span>`);
  all.dataset.type = 'ALL';
  all.setAttribute('aria-pressed', 'true');
  all.type = 'button';
  chips.appendChild(all);

  for (const t of types) {
    const c = elt('button', 'chip', `<span class="dot"></span>${escapeHtml(t)} <span class="count">${counts[t]}</span>`);
    c.dataset.type = t;
    c.setAttribute('aria-pressed', 'false');
    c.type = 'button';
    chips.appendChild(c);
  }

  chips.addEventListener('click', e => {
    const btn = e.target.closest('.chip');
    if (!btn) return;
    const t = btn.dataset.type;
    if (t === 'ALL') {
      state.types = new Set(['ALL']);
    } else {
      state.types.delete('ALL');
      if (state.types.has(t)) state.types.delete(t);
      else state.types.add(t);
      if (state.types.size === 0) state.types = new Set(['ALL']);
    }
    chips.querySelectorAll('.chip').forEach(c => {
      c.setAttribute('aria-pressed', state.types.has(c.dataset.type) ? 'true' : 'false');
    });
    render();
  });
}

// ---------- controls ----------
function bindControls() {
  $('#viewList').addEventListener('click', () => setView('list'));
  $('#viewGrid').addEventListener('click', () => setView('grid'));
  $('#downloadAll').addEventListener('click', downloadAllVisible);
  $('#downloadAll').disabled = false;
}

function setView(v) {
  state.view = v;
  $('#viewList').setAttribute('aria-pressed', v === 'list' ? 'true' : 'false');
  $('#viewGrid').setAttribute('aria-pressed', v === 'grid' ? 'true' : 'false');
  render();
}

function visibleImages() {
  if (state.types.has('ALL')) return state.images;
  return state.images.filter(i => state.types.has(i.type));
}

// ---------- render ----------
function thumbHTML(img) {
  if (img.broken) {
    return `<div class="thumb broken" title="Image failed to load">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11"/><path d="m21 21-6-6"/><path d="m15 21 6-6"/></svg>
    </div>`;
  }
  return `<div class="thumb"><img src="${escapeHtml(img.src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-thumb></div>`;
}

function metaHTML(img) {
  const altLine = img.alt
    ? `<div class="alt" title="${escapeHtml(img.alt)}">${escapeHtml(img.alt)}</div>`
    : `<div class="alt missing"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>Missing alt text</div>`;
  const dims = (img.w && img.h) ? `<span>${img.w}&thinsp;×&thinsp;${img.h}</span><span class="sep"></span>` : '';
  return `
    <div class="meta">
      <div class="filename" title="${escapeHtml(img.src)}">${escapeHtml(img.name)}</div>
      ${altLine}
      <div class="specs">
        <span class="tag">${escapeHtml(img.type)}</span>
        ${dims}
        <span data-size>${fmtSize(img.bytes)}</span>
      </div>
    </div>`;
}

function actionsHTML(idx, variant) {
  const wrapper = variant === 'grid' ? 'card-actions' : 'actions';
  const copyBtn = variant === 'grid' ? '' : `
    <button class="icon-btn" title="Copy URL" data-act="copy" data-i="${idx}" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    </button>`;
  return `
    <div class="${wrapper}">
      ${copyBtn}
      <button class="icon-btn" title="Open in new tab" data-act="open" data-i="${idx}" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>
      </button>
      <button class="icon-btn primary" title="Download" data-act="dl" data-i="${idx}" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>
      </button>
    </div>`;
}

function render() {
  const items = visibleImages();
  const list = $('#list'), grid = $('#grid'), empty = $('#empty');
  list.innerHTML = '';
  grid.innerHTML = '';

  if (items.length === 0) {
    list.hidden = true;
    grid.hidden = true;
    empty.hidden = false;
  } else {
    empty.hidden = true;
    if (state.view === 'list') {
      list.hidden = false;
      grid.hidden = true;
      items.forEach(img => {
        const idx = state.images.indexOf(img);
        const li = elt('li', 'row');
        li.dataset.i = idx;
        li.innerHTML = thumbHTML(img) + metaHTML(img) + actionsHTML(idx, 'list');
        list.appendChild(li);
      });
    } else {
      list.hidden = true;
      grid.hidden = false;
      items.forEach(img => {
        const idx = state.images.indexOf(img);
        const card = elt('div', 'card');
        card.dataset.i = idx;
        card.innerHTML = thumbHTML(img) + metaHTML(img) + actionsHTML(idx, 'grid');
        grid.appendChild(card);
      });
    }
    // mark broken thumbs after they fail to load
    document.querySelectorAll('[data-thumb]').forEach(el => {
      el.addEventListener('error', () => {
        const wrap = el.parentElement;
        if (!wrap) return;
        wrap.classList.add('broken');
        wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11"/><path d="m21 21-6-6"/><path d="m15 21 6-6"/></svg>`;
        const i = Number(wrap.closest('[data-i]')?.dataset.i);
        if (state.images[i]) state.images[i].broken = true;
      }, { once: true });
    });
  }

  $('#totalCount').textContent = state.images.length;
  $('#visibleCount').textContent = items.length;
  const totalBytes = items.reduce((s, i) => s + (i.bytes || 0), 0);
  $('#totalSize').textContent = totalBytes ? fmtTotal(totalBytes) : '—';
  const missing = items.filter(i => !i.alt).length;
  $('#missingAlt').textContent = missing;
  $('#missingAlt').style.color = missing ? 'var(--warn)' : 'var(--ok)';
}

// ---------- size hydration (HEAD requests) ----------
async function hydrateSizes() {
  const queue = state.images.filter(i => !i.bytes && !i.src.startsWith('data:'));
  let active = 0, done = 0;
  const max = 6;

  await new Promise(resolve => {
    const next = () => {
      while (active < max && queue.length) {
        const img = queue.shift();
        active++;
        fetchSize(img.src).then(bytes => {
          if (bytes != null) {
            img.bytes = bytes;
            updateRowSize(img);
          }
        }).catch(() => {}).finally(() => {
          active--; done++;
          if (queue.length === 0 && active === 0) resolve();
          else next();
        });
      }
    };
    next();
    if (queue.length === 0) resolve();
  });

  // refresh totals after hydration
  const items = visibleImages();
  const totalBytes = items.reduce((s, i) => s + (i.bytes || 0), 0);
  $('#totalSize').textContent = totalBytes ? fmtTotal(totalBytes) : '—';
}

async function fetchSize(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!r.ok) return null;
    const len = r.headers.get('content-length');
    return len ? Number(len) : null;
  } catch {
    return null;
  }
}

function updateRowSize(img) {
  const idx = state.images.indexOf(img);
  if (idx < 0) return;
  const node = document.querySelector(`[data-i="${idx}"] [data-size]`);
  if (node) node.textContent = fmtSize(img.bytes);
}

// ---------- actions ----------
document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const img = state.images[Number(btn.dataset.i)];
  if (!img) return;

  if (btn.dataset.act === 'copy') {
    try { await navigator.clipboard.writeText(img.src); flash(btn, 'Copied'); }
    catch { flash(btn, 'Failed'); }
  } else if (btn.dataset.act === 'open') {
    chrome.tabs.create({ url: img.src });
  } else if (btn.dataset.act === 'dl') {
    download(img);
  }
});

function download(img) {
  chrome.downloads.download({ url: img.src, filename: safeFilename(img.name), saveAs: false }).catch(() => {});
}

function downloadAllVisible() {
  const items = visibleImages().filter(i => !i.broken);
  items.forEach((img, k) => setTimeout(() => download(img), k * 150));
}

function safeFilename(n) {
  // chrome.downloads disallows path traversal & some chars
  return n.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180) || 'image';
}

function flash(el, msg) {
  const original = el.getAttribute('title');
  el.setAttribute('title', msg);
  el.style.transform = 'scale(0.92)';
  setTimeout(() => { el.style.transform = ''; el.setAttribute('title', original || ''); }, 600);
}

// ---------- error state ----------
function showError(msg) {
  $('#loading').hidden = true;
  $('#error').hidden = false;
  if (msg) $('#errorMsg').textContent = msg;
}
