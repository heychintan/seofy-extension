// Seofy popup — single-page scrape, multi-tab UI.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  data: null, // result of scrapePage
  tab: "overview", // initial tab (matches aria-current in markup)
  // images sub-state
  imgTypes: new Set(["ALL"]),
  imgView: "list",
  // links sub-state
  linkFilter: "ALL", // ALL | INTERNAL | EXTERNAL
  // analysis sub-state
  analysisFilter: "all", // all | failing | warning | passed
  analysisExpanded: new Set(), // category ids expanded in cat list
};

// ---------- entry ----------
init().catch((err) => showError(err?.message || String(err)));

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (
    !tab?.id ||
    !tab.url ||
    /^(chrome|edge|about|chrome-extension|view-source):/i.test(tab.url) ||
    tab.url.startsWith("https://chrome.google.com/webstore")
  ) {
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
  if (!state.data) return showError("No data returned from page.");

  $("#loading").hidden = true;

  // pre-render all tabs once (cheap), then show the active one
  renderOverview();
  renderAnalysis();
  renderHeadings();
  renderLinks();
  renderImages();
  renderSchema();
  renderMeta();
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
    title: document.querySelector("title")?.textContent?.trim() || "",
    description:
      document.querySelector('meta[name="description"]')?.content?.trim() || "",
    canonical: document.querySelector('link[rel="canonical"]')?.href || "",
    robots:
      document.querySelector('meta[name="robots"]')?.content?.trim() || "",
    viewport:
      document.querySelector('meta[name="viewport"]')?.content?.trim() || "",
    charset: document.characterSet || "",
    lang: document.documentElement.getAttribute("lang") || "",
    favicon: (document.querySelector('link[rel~="icon"]') || {}).href || "",
    headings: [],
    links: [],
    images: [],
    schema: [],
    og: {},
    twitter: {},
    meta: [], // all <meta> tags (name | property | http-equiv | charset)
    hreflang: [],
  };

  // headings (preserve document order)
  document.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    out.headings.push({
      level: Number(h.tagName[1]),
      text: (h.textContent || "").replace(/\s+/g, " ").trim(),
    });
  });

  // links
  const origin = location.origin;
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) return;
    let abs;
    try {
      abs = new URL(href, document.baseURI).href;
    } catch {
      return;
    }
    let internal = false;
    try {
      internal = new URL(abs).origin === origin;
    } catch {}
    out.links.push({
      url: abs,
      anchor: (a.textContent || "").replace(/\s+/g, " ").trim(),
      rel: a.getAttribute("rel") || "",
      target: a.getAttribute("target") || "",
      internal,
    });
  });

  // assets (images + videos folded into the same array)
  const seenAsset = new Set();
  const pushAsset = (src, alt, w, h, kind, poster) => {
    if (!src) return;
    let abs;
    try {
      abs = new URL(src, document.baseURI).href;
    } catch {
      return;
    }
    if (!/^https?:|^data:|^blob:/i.test(abs)) return;
    if (seenAsset.has(abs)) return;
    seenAsset.add(abs);
    out.images.push({
      src: abs,
      alt: (alt || "").trim(),
      w: w || 0,
      h: h || 0,
      kind,
      poster: poster || "",
    });
  };

  // <img>
  document.querySelectorAll("img").forEach((img) => {
    const src =
      img.currentSrc ||
      img.src ||
      img.getAttribute("data-src") ||
      img.getAttribute("data-lazy-src") ||
      img.getAttribute("data-original");
    pushAsset(
      src,
      img.alt,
      img.naturalWidth || img.width,
      img.naturalHeight || img.height,
      "image",
    );
  });
  // <picture><source srcset>
  document.querySelectorAll("picture source").forEach((s) => {
    const set = s.getAttribute("srcset");
    if (!set) return;
    set
      .split(",")
      .forEach((p) => pushAsset(p.trim().split(/\s+/)[0], "", 0, 0, "image"));
  });
  // <svg><image>
  document.querySelectorAll("svg image").forEach((im) => {
    pushAsset(
      im.getAttribute("href") || im.getAttribute("xlink:href"),
      "",
      0,
      0,
      "image",
    );
  });
  // CSS background-image
  let bgScanned = 0;
  for (const el of document.querySelectorAll("*")) {
    if (bgScanned > 600) break;
    bgScanned++;
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === "none") continue;
    const re = /url\((['"]?)(.*?)\1\)/g;
    let m;
    while ((m = re.exec(bg)) !== null) pushAsset(m[2], "", 0, 0, "image");
  }

  // <video> + <video><source> (also pull poster as a separate image asset)
  document.querySelectorAll("video").forEach((v) => {
    const w = v.videoWidth || v.clientWidth || 0;
    const h = v.videoHeight || v.clientHeight || 0;
    const direct = v.currentSrc || v.src || v.getAttribute("src");
    if (direct) {
      pushAsset(
        direct,
        v.getAttribute("aria-label") || "",
        w,
        h,
        "video",
        v.poster,
      );
    }
    v.querySelectorAll("source").forEach((s) => {
      const src = s.src || s.getAttribute("src");
      if (src) pushAsset(src, "", w, h, "video", v.poster);
    });
    if (v.poster) pushAsset(v.poster, "", 0, 0, "image");
  });

  // <audio> + <audio><source> (rare on SEO pages but cheap to include)
  document.querySelectorAll("audio").forEach((a) => {
    const direct = a.currentSrc || a.src || a.getAttribute("src");
    if (direct) pushAsset(direct, "", 0, 0, "audio");
    a.querySelectorAll("source").forEach((s) => {
      const src = s.src || s.getAttribute("src");
      if (src) pushAsset(src, "", 0, 0, "audio");
    });
  });

  // <iframe> video embeds — recognise common providers and synthesise a
  // canonical "watch" URL + poster image when the provider exposes one.
  // We push the watch URL (not the embed URL) so copy/open lands on the
  // viewable page, not the iframe.
  const EMBEDS = [
    {
      name: "YouTube",
      re: /(?:youtube\.com\/embed\/|youtu\.be\/|youtube-nocookie\.com\/embed\/)([\w-]{11})/i,
      poster: (id) => `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
      watch: (id) => `https://www.youtube.com/watch?v=${id}`,
    },
    {
      name: "Vimeo",
      re: /player\.vimeo\.com\/video\/(\d+)/i,
      poster: () => "",
      watch: (id) => `https://vimeo.com/${id}`,
    },
    {
      name: "Loom",
      re: /loom\.com\/embed\/([a-f0-9]+)/i,
      poster: (id) =>
        `https://cdn.loom.com/sessions/thumbnails/${id}-with-play.gif`,
      watch: (id) => `https://www.loom.com/share/${id}`,
    },
    {
      name: "Wistia",
      re: /(?:fast\.wistia\.net\/embed\/iframe|fast\.wistia\.com\/embed\/medias)\/([a-z0-9]+)/i,
      poster: () => "",
      watch: (id) => `https://wistia.com/medias/${id}`,
    },
    {
      name: "Dailymotion",
      re: /dailymotion\.com\/embed\/video\/([a-z0-9]+)/i,
      poster: (id) => `https://www.dailymotion.com/thumbnail/video/${id}`,
      watch: (id) => `https://www.dailymotion.com/video/${id}`,
    },
    {
      name: "TikTok",
      re: /tiktok\.com\/embed\/v?\d?\/?(\d+)/i,
      poster: () => "",
      watch: (id) => `https://www.tiktok.com/embed/${id}`,
    },
  ];

  document.querySelectorAll("iframe[src]").forEach((f) => {
    const raw = f.getAttribute("src");
    if (!raw) return;
    let abs;
    try {
      abs = new URL(raw, document.baseURI).href;
    } catch {
      return;
    }
    for (const p of EMBEDS) {
      const m = abs.match(p.re);
      if (!m) continue;
      const id = m[1];
      const watch = p.watch(id);
      if (seenAsset.has(watch)) break;
      seenAsset.add(watch);
      out.images.push({
        src: watch,
        alt: (f.title || f.getAttribute("aria-label") || "").trim(),
        w: f.clientWidth || 0,
        h: f.clientHeight || 0,
        kind: "embed",
        poster: p.poster(id),
        provider: p.name,
      });
      break;
    }
  });

  // JSON-LD schema
  document
    .querySelectorAll('script[type="application/ld+json"]')
    .forEach((s) => {
      try {
        const parsed = JSON.parse(s.textContent || "");
        out.schema.push(parsed);
      } catch {
        /* ignore malformed */
      }
    });

  // og: + twitter: meta
  document
    .querySelectorAll(
      'meta[property^="og:"], meta[property^="article:"], meta[property^="profile:"]',
    )
    .forEach((m) => {
      const k = m.getAttribute("property");
      const v = m.getAttribute("content");
      if (k && v != null) out.og[k] = v;
    });
  document.querySelectorAll('meta[name^="twitter:"]').forEach((m) => {
    const k = m.getAttribute("name");
    const v = m.getAttribute("content");
    if (k && v != null) out.twitter[k] = v;
  });

  // every <meta> tag — keep raw so the Meta tab can show the full picture
  document.querySelectorAll("meta").forEach((m) => {
    const name = m.getAttribute("name");
    const property = m.getAttribute("property");
    const httpEq = m.getAttribute("http-equiv");
    const charset = m.getAttribute("charset");
    const content = m.getAttribute("content");
    let key, kind;
    if (name) {
      key = name;
      kind = "name";
    } else if (property) {
      key = property;
      kind = "property";
    } else if (httpEq) {
      key = httpEq;
      kind = "http-equiv";
    } else if (charset) {
      key = "charset";
      kind = "charset";
    } else return;
    out.meta.push({
      key,
      kind,
      value: charset != null ? charset : (content ?? ""),
    });
  });

  // hreflang
  document.querySelectorAll('link[rel="alternate"][hreflang]').forEach((l) => {
    out.hreflang.push({ lang: l.getAttribute("hreflang"), href: l.href });
  });

  return out;
}

// ---------- nav ----------
function bindNav() {
  $("#nav").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-tab]");
    if (!a) return;
    e.preventDefault();
    showTab(a.dataset.tab);
  });
}

function showTab(name) {
  state.tab = name;
  $$("#nav a").forEach((a) => {
    if (a.dataset.tab === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $$(".tab").forEach((t) => {
    t.hidden = true;
  });
  const panel = document.getElementById("tab-" + name);
  if (panel) panel.hidden = false;
}

// ---------- shared helpers ----------
const elt = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const escapeHtml = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmtSize = (b) => {
  if (!b) return "—";
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10 * 1024 ? 1 : 0) + " KB";
  return (b / (1024 * 1024)).toFixed(2) + " MB";
};
const fmtTotal = (b) => {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  return (b / (1024 * 1024)).toFixed(1) + " MB";
};

const ICONS = {
  title: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m4 12 8-9 8 9"/><path d="M12 3v18"/></svg>`,
  desc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`,
  link: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>`,
  canon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/></svg>`,
  robot: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  open: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>`,
};

function fieldRow(icon, label, valueHTML, badgeHTML = "", copyText = null) {
  const inlineCopy =
    copyText != null && copyText !== ""
      ? copyBtn(copyText, `Copy ${label.toLowerCase()}`, "inline")
      : "";
  return `
    <div class="field">
      <div class="label"><span class="ico">${icon}</span>${escapeHtml(label)}</div>
      <div class="row-actions">${badgeHTML || ""}</div>
      <div class="value ${valueHTML ? "" : "muted"}">${valueHTML || "Not set"}${inlineCopy}</div>
    </div>`;
}

// ---------- mini-button helpers ----------
function copyBtn(text, ariaLabel = "Copy", cls = "") {
  // store payload via data-copy attribute (escape carefully)
  const payload = String(text)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<button type="button" class="mini ${cls}" data-act="copy-text" data-copy="${payload}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(ariaLabel)}">${ICONS.copy}<span class="sr-only">${escapeHtml(ariaLabel)}</span></button>`;
}

function dlBtn(url, filename, ariaLabel = "Download", cls = "") {
  return `<button type="button" class="mini ${cls}" data-act="dl-url" data-url="${escapeHtml(url)}" data-filename="${escapeHtml(filename || "")}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(ariaLabel)}">${ICONS.download}<span class="sr-only">${escapeHtml(ariaLabel)}</span></button>`;
}

function openBtn(url, ariaLabel = "Open in new tab", cls = "") {
  return `<button type="button" class="mini ${cls}" data-act="open-url" data-url="${escapeHtml(url)}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(ariaLabel)}">${ICONS.open}<span class="sr-only">${escapeHtml(ariaLabel)}</span></button>`;
}

// SEO length thresholds based on Google SERP rendering:
//   title       — sweet spot 30–60 chars (warn under 30, warn over 60)
//   description — sweet spot 70–160 chars (warn under 70, warn over 160)
function lengthBadge(len, { min, max, soft }) {
  if (len === 0) return `<span class="badge warn">${ICONS.warn} Missing</span>`;
  if (len < min)
    return `<span class="badge warn">${ICONS.warn} ${len} chars · too short</span>`;
  if (len <= max)
    return `<span class="badge ok">${ICONS.check} ${len} chars</span>`;
  if (len <= soft) return `<span class="badge info">${len} chars · long</span>`;
  return `<span class="badge warn">${ICONS.warn} ${len} chars · too long</span>`;
}

// =============================================================
// OVERVIEW
// =============================================================
function renderOverview() {
  const d = state.data;
  const titleLen = d.title.length;
  const descLen = d.description.length;
  const canonOk =
    d.canonical && (d.canonical === d.url || d.canonical === d.finalUrl);

  $("#tab-overview").innerHTML = `
    <div class="fields">
      ${fieldRow(ICONS.title, "Title", escapeHtml(d.title), lengthBadge(titleLen, { min: 30, max: 60, soft: 70 }), d.title)}
      ${fieldRow(ICONS.desc, "Description", escapeHtml(d.description), lengthBadge(descLen, { min: 70, max: 160, soft: 175 }), d.description)}
      ${fieldRow(ICONS.link, "URL", escapeHtml(d.url), "", d.url)}
      ${fieldRow(
        ICONS.canon,
        "Canonical",
        d.canonical
          ? `<a href="${escapeHtml(d.canonical)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escapeHtml(d.canonical)}</a>`
          : "",
        canonOk
          ? `<span class="badge ok">${ICONS.check} Self-referencing</span>`
          : d.canonical
            ? `<span class="badge info">External</span>`
            : `<span class="badge muted">None</span>`,
        d.canonical,
      )}
      ${fieldRow(
        ICONS.robot,
        "Robots",
        escapeHtml(d.robots) ||
          '<span class="muted">Default (index, follow)</span>',
        /noindex/i.test(d.robots)
          ? `<span class="badge warn">${ICONS.warn} noindex</span>`
          : "",
        d.robots,
      )}
      ${fieldRow(
        ICONS.globe,
        "Language",
        escapeHtml(d.lang) || "",
        d.lang
          ? `<span class="badge muted">${escapeHtml(d.lang)}</span>`
          : `<span class="badge warn">${ICONS.warn} No lang attr</span>`,
        d.lang,
      )}
    </div>`;
}

// =============================================================
// HEADINGS
// =============================================================
function renderHeadings() {
  const d = state.data;
  const counts = [0, 0, 0, 0, 0, 0, 0]; // index 0 unused
  d.headings.forEach((h) => counts[h.level]++);
  const h1Count = counts[1];

  let summary = `<div class="summary">`;
  for (let i = 1; i <= 6; i++) {
    const warn = i === 1 && h1Count !== 1;
    summary += `<div class="stat"><span class="k">${counts[i]}</span><span class="v ${warn ? "warn" : ""}">H${i}</span></div>`;
  }
  summary += `<div class="stat"><span class="k">${d.images.length}</span><span class="v">Images</span></div>`;
  summary += `<div class="stat"><span class="k">${d.links.length}</span><span class="v">Links</span></div>`;
  summary += `</div>`;

  let rows = "";
  if (d.headings.length === 0) {
    rows = `<div class="empty"><span class="em">No headings.</span>This page has no h1–h6 tags.</div>`;
  } else {
    rows = `<div class="headings">`;
    d.headings.forEach((h) => {
      const indent = Math.max(0, h.level - 1);
      const empty = !h.text;
      const inlineCopy = empty
        ? ""
        : copyBtn(h.text, `Copy H${h.level} text`, "inline");
      rows += `<div class="heading lvl-${h.level} ${empty ? "empty" : ""}" data-indent="${indent}">
        <span class="tag">H${h.level}</span>
        <span class="text">${empty ? "Empty heading" : escapeHtml(h.text)}${inlineCopy}</span>
        <span></span>
      </div>`;
    });
    rows += `</div>`;
  }

  $("#tab-headings").innerHTML = summary + rows;
}

// =============================================================
// LINKS
// =============================================================
function renderLinks() {
  const d = state.data;
  const internal = d.links.filter((l) => l.internal);
  const external = d.links.filter((l) => !l.internal);
  const unique = new Set(d.links.map((l) => l.url)).size;

  const filterChips = `
    <div class="linkfilter">
      <button class="chip" data-lf="ALL"      aria-pressed="${state.linkFilter === "ALL"}" type="button">All <span class="count">${d.links.length}</span></button>
      <button class="chip" data-lf="INTERNAL" aria-pressed="${state.linkFilter === "INTERNAL"}" type="button"><span class="dot"></span>Internal <span class="count">${internal.length}</span></button>
      <button class="chip" data-lf="EXTERNAL" aria-pressed="${state.linkFilter === "EXTERNAL"}" type="button"><span class="dot"></span>External <span class="count">${external.length}</span></button>
      <span style="flex:1"></span>
      <span class="badge muted" style="align-self:center">${unique} unique</span>
    </div>`;

  const items =
    state.linkFilter === "INTERNAL"
      ? internal
      : state.linkFilter === "EXTERNAL"
        ? external
        : d.links;

  let body = "";
  if (items.length === 0) {
    body = `<div class="empty"><span class="em">No links.</span>Nothing here for this filter.</div>`;
  } else {
    body = `<div class="links">`;
    items.forEach((l) => {
      const tags = [];
      if (l.rel)
        l.rel
          .split(/\s+/)
          .forEach((r) =>
            tags.push(`<span class="badge muted">${escapeHtml(r)}</span>`),
          );
      if (l.target === "_blank")
        tags.push(`<span class="badge info">_blank</span>`);
      body += `
        <div class="linkrow">
          <span class="anchor ${l.anchor ? "" : "noanchor"}">${l.anchor ? escapeHtml(l.anchor) : "No anchor text"}</span>
          <span class="meta-tags">${tags.join("")}</span>
          <span class="url"><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.url)}</a>${copyBtn(l.url, "Copy link URL", "inline")}${openBtn(l.url, "Open link", "inline")}</span>
        </div>`;
    });
    body += `</div>`;
  }

  $("#tab-links").innerHTML = filterChips + body;

  // bind chip clicks
  $("#tab-links")
    .querySelectorAll("[data-lf]")
    .forEach((c) => {
      c.addEventListener("click", () => {
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
    $("#tab-images").innerHTML =
      `<div class="empty"><span class="em">No assets.</span>This page contains no images, videos, or CSS background media.</div>`;
    return;
  }

  // ensure each asset has type/name/bytes (kind is set during scrape)
  imgs.forEach((i) => {
    if (!i.kind) i.kind = "image";
    if (!i.type) {
      if (i.kind === "embed" && i.provider) {
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

  let chips = `<button class="chip" data-it="ALL" aria-pressed="${state.imgTypes.has("ALL")}" type="button">All <span class="count">${imgs.length}</span></button>`;
  for (const t of types) {
    chips += `<button class="chip" data-it="${escapeHtml(t)}" aria-pressed="${state.imgTypes.has(t)}" type="button"><span class="dot"></span>${escapeHtml(t)} <span class="count">${counts[t]}</span></button>`;
  }

  const visible = state.imgTypes.has("ALL")
    ? imgs
    : imgs.filter((i) => state.imgTypes.has(i.type));
  const totalBytes = visible.reduce((s, i) => s + (i.bytes || 0), 0);
  // missing-alt only applies to images, not videos/audio/embeds
  const missing = visible.filter((i) => i.kind === "image" && !i.alt).length;
  const videoCount = visible.filter((i) => i.kind === "video").length;
  const embedCount = visible.filter((i) => i.kind === "embed").length;

  let body = "";
  if (visible.length === 0) {
    body = `<div class="empty"><span class="em">Nothing matches.</span>Try a different file-type filter.</div>`;
  } else if (state.imgView === "list") {
    body = `<ul class="list">`;
    visible.forEach((img) => {
      const idx = imgs.indexOf(img);
      body += `<li class="row" data-i="${idx}">${imgThumbHTML(img)}${imgMetaHTML(img)}${imgActionsHTML(idx, "list")}</li>`;
    });
    body += `</ul>`;
  } else {
    body = `<div class="grid">`;
    visible.forEach((img) => {
      const idx = imgs.indexOf(img);
      body += `<div class="card" data-i="${idx}">${imgThumbHTML(img)}${imgMetaHTML(img)}${imgActionsHTML(idx, "grid")}</div>`;
    });
    body += `</div>`;
  }

  $("#tab-images").innerHTML = `
    <header class="header">
      <div>
        <h1>Page <em>assets</em></h1>
        <div class="sub">
          <b>${visible.length}</b> of <b>${imgs.length}</b> assets
          ${videoCount ? `<span class="sep">·</span><b>${videoCount}</b> video${videoCount === 1 ? "" : "s"}` : ""}
          ${embedCount ? `<span class="sep">·</span><b>${embedCount}</b> embed${embedCount === 1 ? "" : "s"}` : ""}
          <span class="sep">·</span>
          <b>${totalBytes ? fmtTotal(totalBytes) : "—"}</b> total
          <span class="sep">·</span>
          <b style="color: var(--warn)">${missing}</b> img${missing === 1 ? "" : "s"} missing alt
        </div>
      </div>
      <button class="download-all" id="downloadAll" type="button" title="Download all visible images">
        ${ICONS.download} Download all
      </button>
    </header>
    <div class="toolbar" role="toolbar" aria-label="Filter and view options">
      <div class="chips" id="imgChips" role="group" aria-label="Filter by file type">${chips}</div>
      <div class="view-toggle" role="group" aria-label="View">
        <button id="viewList" aria-pressed="${state.imgView === "list"}" aria-label="List" title="List">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>
        </button>
        <button id="viewGrid" aria-pressed="${state.imgView === "grid"}" aria-label="Grid" title="Grid">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        </button>
      </div>
    </div>
    ${body}
  `;

  // bindings
  $("#tab-images")
    .querySelectorAll("#imgChips .chip")
    .forEach((c) => {
      c.addEventListener("click", () => {
        const t = c.dataset.it;
        if (t === "ALL") state.imgTypes = new Set(["ALL"]);
        else {
          state.imgTypes.delete("ALL");
          if (state.imgTypes.has(t)) state.imgTypes.delete(t);
          else state.imgTypes.add(t);
          if (state.imgTypes.size === 0) state.imgTypes = new Set(["ALL"]);
        }
        renderImages();
      });
    });
  $("#viewList").addEventListener("click", () => {
    state.imgView = "list";
    renderImages();
  });
  $("#viewGrid").addEventListener("click", () => {
    state.imgView = "grid";
    renderImages();
  });
  $("#downloadAll").addEventListener("click", () => {
    // skip embeds (would download the iframe HTML, not the video)
    visible
      .filter((i) => !i.broken && i.kind !== "embed")
      .forEach((img, k) => setTimeout(() => downloadImg(img), k * 150));
  });

  // mark broken thumbs
  $("#tab-images")
    .querySelectorAll("[data-thumb]")
    .forEach((el) => {
      el.addEventListener(
        "error",
        () => {
          const wrap = el.parentElement;
          if (!wrap) return;
          wrap.classList.add("broken");
          wrap.innerHTML =
            ICONS.brokenImg ||
            `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11"/><path d="m21 21-6-6"/><path d="m15 21 6-6"/></svg>`;
          const i = Number(wrap.closest("[data-i]")?.dataset.i);
          if (imgs[i]) imgs[i].broken = true;
        },
        { once: true },
      );
    });
}

function parseImgUrl(src) {
  let name = "",
    type = "OTHER";
  if (src.startsWith("data:")) {
    const m = src.match(/^data:image\/([a-z0-9+.-]+)/i);
    type = (m?.[1] || "data")
      .toUpperCase()
      .replace("SVG+XML", "SVG")
      .replace("JPEG", "JPG");
    return { name: `inline.${type.toLowerCase()}`, type };
  }
  try {
    const u = new URL(src);
    name = decodeURIComponent(
      u.pathname.split("/").filter(Boolean).pop() || u.hostname,
    );
    const m = u.pathname.match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
    type = m
      ? m[1].toUpperCase().replace("JPEG", "JPG").replace("SVG+XML", "SVG")
      : "IMG";
  } catch {}
  return { name: name || "image", type };
}

function imgThumbHTML(img) {
  if (img.broken) {
    return `<div class="thumb broken" title="Asset failed to load">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11"/><path d="m21 21-6-6"/><path d="m15 21 6-6"/></svg>
    </div>`;
  }
  if (img.kind === "video") {
    // Prefer the poster image (no decode cost). Fall back to the video itself
    // with preload=metadata so the browser pulls just enough to render frame 1.
    const inner = img.poster
      ? `<img src="${escapeHtml(img.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-thumb>`
      : `<video src="${escapeHtml(img.src)}" muted playsinline preload="metadata" referrerpolicy="no-referrer" data-thumb></video>`;
    return `<div class="thumb media">${inner}<span class="play-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span></div>`;
  }
  if (img.kind === "embed") {
    const inner = img.poster
      ? `<img src="${escapeHtml(img.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-thumb>`
      : `<div class="provider-tile">${escapeHtml(img.provider || "Embed")}</div>`;
    return `<div class="thumb media">${inner}<span class="play-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span></div>`;
  }
  if (img.kind === "audio") {
    return `<div class="thumb media audio" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
    </div>`;
  }
  return `<div class="thumb"><img src="${escapeHtml(img.src)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-thumb></div>`;
}
function imgMetaHTML(img) {
  const isEmbed = img.kind === "embed";
  const isMedia = img.kind !== "image";
  // alt only meaningful for images; for embeds show iframe title or "Untitled"
  let altLine;
  if (isEmbed) {
    altLine = `<div class="alt">${img.alt ? escapeHtml(img.alt) : '<span class="muted">No iframe title</span>'}</div>`;
  } else if (isMedia) {
    altLine = `<div class="alt muted">${img.kind === "video" ? "Video file" : "Audio file"}</div>`;
  } else if (img.alt) {
    altLine = `<div class="alt" title="${escapeHtml(img.alt)}">${escapeHtml(img.alt)}</div>`;
  } else {
    altLine = `<div class="alt missing">${ICONS.warn}Missing alt text</div>`;
  }
  const dims =
    img.w && img.h ? `<span>${img.w}&thinsp;×&thinsp;${img.h}</span>` : "";
  const sizeCell = isEmbed
    ? ""
    : (dims ? `<span class="sep"></span>` : "") +
      `<span data-size>${fmtSize(img.bytes)}</span>`;
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
  const wrap = variant === "grid" ? "card-actions" : "actions";
  const isEmbed = img && img.kind === "embed";
  const copy =
    variant === "grid"
      ? ""
      : `<button class="icon-btn" title="${isEmbed ? "Copy watch URL" : "Copy"}" data-act="img-copy" data-i="${idx}" type="button">${ICONS.copy}</button>`;
  const dl = isEmbed
    ? ""
    : `<button class="icon-btn primary" title="Download" data-act="img-dl" data-i="${idx}" type="button">${ICONS.download}</button>`;
  return `
    <div class="${wrap}">
      ${copy}
      <button class="icon-btn ${isEmbed ? "primary" : ""}" title="Open in new tab" data-act="img-open" data-i="${idx}" type="button">${ICONS.open}</button>
      ${dl}
    </div>`;
}

function downloadImg(img) {
  chrome.downloads
    .download({
      url: img.src,
      filename: (img.name || "image")
        .replace(/[\\/:*?"<>|]+/g, "_")
        .slice(0, 180),
      saveAs: false,
    })
    .catch(() => {});
}

async function hydrateImageSizes() {
  const imgs = state.data.images;
  // skip data:/blob: URIs and iframe embeds (HEAD on an HTML page is noise)
  const queue = imgs.filter(
    (i) =>
      !i.bytes &&
      !i.src.startsWith("data:") &&
      !i.src.startsWith("blob:") &&
      i.kind !== "embed",
  );
  let active = 0;
  const max = 6;

  await new Promise((resolve) => {
    if (queue.length === 0) return resolve();
    const next = () => {
      while (active < max && queue.length) {
        const img = queue.shift();
        active++;
        fetchSize(img.src)
          .then((b) => {
            if (b != null) {
              img.bytes = b;
              const node = document.querySelector(
                `#tab-images [data-i="${imgs.indexOf(img)}"] [data-size]`,
              );
              if (node) node.textContent = fmtSize(b);
            }
          })
          .catch(() => {})
          .finally(() => {
            active--;
            if (queue.length === 0 && active === 0) resolve();
            else next();
          });
      }
    };
    next();
  });

  // refresh totals if Images tab is currently visible
  if (state.tab === "images") {
    const visible = state.imgTypes.has("ALL")
      ? imgs
      : imgs.filter((i) => state.imgTypes.has(i.type));
    const totalBytes = visible.reduce((s, i) => s + (i.bytes || 0), 0);
    const sub = $("#tab-images .header .sub");
    if (sub) {
      const bs = sub.querySelectorAll("b");
      if (bs[2]) bs[2].textContent = totalBytes ? fmtTotal(totalBytes) : "—";
    }
  }
}

async function fetchSize(url) {
  try {
    const r = await fetch(url, {
      method: "HEAD",
      mode: "cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!r.ok) return null;
    const len = r.headers.get("content-length");
    return len ? Number(len) : null;
  } catch {
    return null;
  }
}

// =============================================================
// SCHEMA
// =============================================================
function renderSchema() {
  const docs = state.data.schema;

  if (docs.length === 0) {
    $("#tab-schema").innerHTML =
      `<div class="empty"><span class="em">No structured data.</span>This page has no JSON-LD schema.</div>`;
    return;
  }

  // flatten @graph entries to top-level docs
  const flat = [];
  docs.forEach((d, di) => {
    if (Array.isArray(d))
      d.forEach((item) => flat.push({ item, src: `script #${di + 1}` }));
    else if (d && Array.isArray(d["@graph"]))
      d["@graph"].forEach((item) =>
        flat.push({ item, src: `script #${di + 1} @graph` }),
      );
    else flat.push({ item: d, src: `script #${di + 1}` });
  });

  const typeOf = (v) => {
    const t = v?.["@type"];
    if (Array.isArray(t)) return t.join("·");
    if (t) return String(t);
    return Array.isArray(v) ? `Array(${v.length})` : "Object";
  };
  const labelFor = (v) => v?.name || v?.headline || v?.["@id"] || v?.url || "";

  const primVal = (val) => {
    const s = val == null ? "null" : String(val);
    const isUrl = /^https?:\/\//i.test(s);
    return isUrl
      ? `<a class="sv url" href="${escapeHtml(s)}" target="_blank" rel="noopener" title="${escapeHtml(s)}">${escapeHtml(s)}</a>`
      : `<span class="sv">${escapeHtml(s)}</span>`;
  };

  const renderRow = (key, val) => {
    if (val !== null && typeof val === "object") {
      const isArr = Array.isArray(val);
      if (isArr && val.length && val.every((v) => typeof v !== "object")) {
        return `<div class="srow leaf"><span class="sk">${escapeHtml(key)}</span>${primVal(val.join(", "))}</div>`;
      }
      if (isArr && val.length === 0) {
        return `<div class="srow leaf"><span class="sk">${escapeHtml(key)}</span><span class="sv muted">[ ]</span></div>`;
      }
      const entries = isArr
        ? val.map((v, i) => [`[${i}]`, v])
        : Object.entries(val);
      if (entries.length === 0) {
        return `<div class="srow leaf"><span class="sk">${escapeHtml(key)}</span><span class="sv muted">{ }</span></div>`;
      }
      const tag = isArr ? `Array(${val.length})` : typeOf(val);
      const lbl = !isArr ? labelFor(val) : "";
      const meta = lbl ? `${tag} · ${lbl}` : tag;
      return `<details class="snode"><summary class="srow"><span class="schev"></span><span class="sk">${escapeHtml(key)}</span><span class="stag">${escapeHtml(meta)}</span></summary><div class="skids">${entries.map(([k, v]) => renderRow(k, v)).join("")}</div></details>`;
    }
    return `<div class="srow leaf"><span class="sk">${escapeHtml(key)}</span>${primVal(val)}</div>`;
  };

  // group by @type, preserving first-seen order
  const groups = new Map();
  flat.forEach(({ item, src }) => {
    const tag = typeOf(item);
    if (!groups.has(tag)) groups.set(tag, []);
    groups.get(tag).push({ item, src, tag });
  });

  let body = `<div class="schema">`;
  groups.forEach((items, tag) => {
    const groupJson = JSON.stringify(
      items.map((i) => i.item),
      null,
      2,
    );
    body += `<details class="sgroup">
      <summary class="sgroup-head">
        <span class="schev"></span>
        <span class="sdoc-type">${escapeHtml(tag)}</span>
        <span class="sgroup-count">${items.length}</span>
        <span class="sdoc-spacer"></span>
        ${copyBtn(groupJson, "Copy JSON", "always")}
      </summary>
      <div class="sgroup-body">`;
    items.forEach(({ item, src }) => {
      const lbl = labelFor(item);
      const json = JSON.stringify(item, null, 2);
      const entries = Object.entries(item || {});
      body += `<details class="sdoc">
        <summary class="sdoc-head">
          <span class="schev"></span>
          ${lbl ? `<span class="sdoc-name">${escapeHtml(lbl)}</span>` : `<span class="sdoc-name muted">(no name)</span>`}
          <span class="sdoc-spacer"></span>
          <span class="sdoc-src">${escapeHtml(src)}</span>
          ${copyBtn(json, "Copy JSON", "always")}
        </summary>
        <div class="sdoc-body">${entries.map(([k, v]) => renderRow(k, v)).join("")}</div>
      </details>`;
    });
    body += `</div></details>`;
  });
  body += `</div>`;

  $("#tab-schema").innerHTML = body;
}

// =============================================================
// META — all <meta> tags grouped (Primary / Open Graph / Twitter / Other)
// All inserted strings pass through escapeHtml; URLs flow through the same
// helpers (copyBtn / dlBtn) used elsewhere, which already escape attributes.
// =============================================================
function renderMeta() {
  const d = state.data;
  const all = d.meta || [];

  const primary = [
    { key: "title", value: d.title, kind: "tag" },
    { key: "description", value: d.description, kind: "name" },
    { key: "canonical", value: d.canonical, kind: "link" },
    { key: "robots", value: d.robots, kind: "name" },
    { key: "viewport", value: d.viewport, kind: "name" },
    { key: "charset", value: d.charset, kind: "charset" },
    { key: "lang", value: d.lang, kind: "attr" },
  ].filter((r) => r.value);

  const og = all.filter(
    (m) => m.kind === "property" && /^(og|article|profile):/i.test(m.key),
  );
  const twitter = all.filter(
    (m) => m.kind === "name" && /^twitter:/i.test(m.key),
  );

  const primaryNames = new Set(["description", "robots", "viewport"]);
  const other = all.filter((m) => {
    if (m.kind === "property" && /^(og|article|profile):/i.test(m.key))
      return false;
    if (m.kind === "name" && /^twitter:/i.test(m.key)) return false;
    if (m.kind === "name" && primaryNames.has(m.key.toLowerCase()))
      return false;
    if (m.kind === "charset") return false;
    return true;
  });

  if (
    primary.length === 0 &&
    og.length === 0 &&
    twitter.length === 0 &&
    other.length === 0
  ) {
    $("#tab-meta").textContent = "";
    $("#tab-meta").appendChild(
      elt(
        "div",
        "empty",
        `<span class="em">No meta tags.</span>This page has no &lt;meta&gt; data.`,
      ),
    );
    return;
  }

  const groupHTML = (title, items, open) => {
    if (!items.length) return "";
    const rows = items.map((m) => metaRowHTML(m)).join("");
    return `<details class="mgroup"${open ? " open" : ""}>
        <summary class="mgroup-head">
          <span class="schev"></span>
          <span class="mgroup-title">${escapeHtml(title)}</span>
          <span class="mgroup-count">${items.length}</span>
        </summary>
        <div class="mgroup-body">${rows}</div>
      </details>`;
  };

  const html =
    `<div class="meta-tab">` +
    groupHTML("Primary", primary, true) +
    groupHTML("Open Graph", og, true) +
    groupHTML("Twitter Card", twitter, true) +
    groupHTML("Other", other, false) +
    `</div>`;
  $("#tab-meta").innerHTML = html;
}

function metaRowHTML(m) {
  const v = m.value;
  const isUrl = /^https?:\/\//i.test(v);
  const isImg = /(^|:)image(:?$|:url$)/i.test(m.key) && isUrl;
  const valueHTML = isUrl
    ? `<a href="${escapeHtml(v)}" target="_blank" rel="noopener" class="mval-link">${escapeHtml(v)}</a>`
    : `<span class="mval-text">${escapeHtml(v)}</span>`;
  const thumb = isImg
    ? `<img class="mval-thumb" src="${escapeHtml(v)}" alt="" referrerpolicy="no-referrer" loading="lazy">`
    : "";
  const dl = isImg
    ? dlBtn(
        v,
        m.key.replace(/[:]/g, "_") + ".img",
        `Download ${m.key}`,
        "inline",
      )
    : "";
  const copy = v ? copyBtn(v, `Copy ${m.key}`, "inline") : "";
  return `<div class="mrow">
      <span class="mkey">${escapeHtml(m.key)}</span>
      <div class="mval">${thumb}<div class="mval-inner">${valueHTML}</div></div>
      <div class="mact">${copy}${dl}</div>
    </div>`;
}

// =============================================================
// ADVANCED
// =============================================================
function renderAdvanced() {
  const d = state.data;

  let hreflang = "";
  if (d.hreflang.length) {
    hreflang = `<div class="value prose">${d.hreflang.map((h) => `<div><b style="color:var(--ink);font-weight:600">${escapeHtml(h.lang)}</b> → <a href="${escapeHtml(h.href)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escapeHtml(h.href)}</a></div>`).join("")}</div>`;
  }

  const robotsUrl = originOf(d.url) + "/robots.txt";
  const sitemapUrl = originOf(d.url) + "/sitemap.xml";

  $("#tab-advanced").innerHTML = `
    <div class="fields">
      ${fieldRow(ICONS.globe, "Viewport", escapeHtml(d.viewport), d.viewport ? "" : `<span class="badge warn">${ICONS.warn} Missing</span>`, d.viewport)}
      ${fieldRow(ICONS.globe, "Charset", escapeHtml(d.charset), "", d.charset)}
      ${fieldRow(
        ICONS.globe,
        "Favicon",
        d.favicon
          ? `<a href="${escapeHtml(d.favicon)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">${escapeHtml(d.favicon)}</a>`
          : "",
        d.favicon
          ? ""
          : `<span class="badge warn">${ICONS.warn} Missing</span>`,
        d.favicon,
      )}
      <div class="field">
        <div class="label"><span class="ico">${ICONS.globe}</span>Hreflang</div>
        <div class="row-actions"><span class="badge ${d.hreflang.length ? "info" : "muted"}">${d.hreflang.length || "None"}</span></div>
        ${hreflang || '<div class="value muted">No hreflang alternates.</div>'}
      </div>
      <div class="field">
        <div class="label"><span class="ico">${ICONS.link}</span>Robots.txt</div>
        <div class="row-actions">${openBtn(robotsUrl, "Open robots.txt", "always")}${dlBtn(robotsUrl, "robots.txt", "Download robots.txt", "always")}</div>
        <div class="value">${escapeHtml(robotsUrl)}</div>
      </div>
      <div class="field">
        <div class="label"><span class="ico">${ICONS.link}</span>Sitemap.xml</div>
        <div class="row-actions">${openBtn(sitemapUrl, "Open sitemap.xml", "always")}${dlBtn(sitemapUrl, "sitemap.xml", "Download sitemap.xml", "always")}</div>
        <div class="value">${escapeHtml(sitemapUrl)}</div>
      </div>
    </div>`;
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

// =============================================================
// ANALYSIS — SEO + AEO scoring & checklist
// =============================================================

const ANALYSIS_CATEGORIES = [
  { id: "seo", label: "SEO Basics", weight: 0.18 },
  { id: "content", label: "Content & Headings", weight: 0.15 },
  { id: "links", label: "Links", weight: 0.1 },
  { id: "media", label: "Media & Assets", weight: 0.1 },
  { id: "schema", label: "Structured Data", weight: 0.15 },
  { id: "social", label: "Social / Open Graph", weight: 0.08 },
  { id: "aeo", label: "Answer Engine (AEO)", weight: 0.18 },
  { id: "crawl", label: "Crawl & Indexing", weight: 0.06 },
];

const mkCheck = (category, id, label, status, detail, fix, why) => ({
  category,
  id,
  label,
  status,
  score:
    status === "pass"
      ? 100
      : status === "warn"
        ? 60
        : status === "info"
          ? 100
          : 0,
  detail: detail || "",
  fix: fix || "",
  why: why || "",
});

function flattenSchema(docs) {
  const out = [];
  (docs || []).forEach((d) => {
    if (Array.isArray(d)) d.forEach((i) => out.push(i));
    else if (d && Array.isArray(d["@graph"]))
      d["@graph"].forEach((i) => out.push(i));
    else if (d) out.push(d);
  });
  return out;
}
function schemaTypes(items) {
  const types = new Set();
  items.forEach((i) => {
    const t = i?.["@type"];
    if (Array.isArray(t)) t.forEach((x) => types.add(String(x)));
    else if (t) types.add(String(t));
  });
  return types;
}
function findSchemaByType(items, type) {
  return items.filter((i) => {
    const t = i?.["@type"];
    if (Array.isArray(t)) return t.includes(type);
    return t === type;
  });
}

function checkSEOBasics(d) {
  const out = [];
  const tlen = d.title.length,
    dlen = d.description.length;
  if (!tlen)
    out.push(
      mkCheck(
        "seo",
        "title",
        "Title tag",
        "fail",
        "Missing",
        "Add a unique <title> 30–60 chars.",
        "First thing search engines and answer engines parse.",
      ),
    );
  else if (tlen < 30)
    out.push(
      mkCheck(
        "seo",
        "title",
        "Title tag",
        "warn",
        `${tlen} chars · too short`,
        "Aim for 30–60 chars to fill SERP space.",
        "Short titles waste pixels & context.",
      ),
    );
  else if (tlen <= 60)
    out.push(
      mkCheck(
        "seo",
        "title",
        "Title tag",
        "pass",
        `${tlen} chars`,
        "",
        "In the sweet spot.",
      ),
    );
  else if (tlen <= 70)
    out.push(
      mkCheck(
        "seo",
        "title",
        "Title tag",
        "warn",
        `${tlen} chars · long`,
        "Trim to ≤60 chars to avoid SERP truncation.",
        "Google truncates around 60 chars.",
      ),
    );
  else
    out.push(
      mkCheck(
        "seo",
        "title",
        "Title tag",
        "fail",
        `${tlen} chars · too long`,
        "Cut to 30–60 chars.",
        "Will be truncated; intent gets lost.",
      ),
    );

  if (!dlen)
    out.push(
      mkCheck(
        "seo",
        "desc",
        "Meta description",
        "fail",
        "Missing",
        "Add a meta description 70–160 chars.",
        "Drives SERP CTR & is parsed by AI summarizers.",
      ),
    );
  else if (dlen < 70)
    out.push(
      mkCheck(
        "seo",
        "desc",
        "Meta description",
        "warn",
        `${dlen} chars · too short`,
        "Expand to 70–160 chars.",
        "Underused space; weak summary signal.",
      ),
    );
  else if (dlen <= 160)
    out.push(
      mkCheck(
        "seo",
        "desc",
        "Meta description",
        "pass",
        `${dlen} chars`,
        "",
        "",
      ),
    );
  else if (dlen <= 175)
    out.push(
      mkCheck(
        "seo",
        "desc",
        "Meta description",
        "warn",
        `${dlen} chars · long`,
        "Trim to ≤160.",
        "May truncate on mobile SERPs.",
      ),
    );
  else
    out.push(
      mkCheck(
        "seo",
        "desc",
        "Meta description",
        "fail",
        `${dlen} chars · too long`,
        "Trim to 70–160.",
        "Truncation hurts CTR.",
      ),
    );

  if (!d.canonical)
    out.push(
      mkCheck(
        "seo",
        "canonical",
        "Canonical URL",
        "warn",
        "Missing",
        'Add <link rel="canonical" href="…">.',
        "Prevents duplicate-content fragmentation.",
      ),
    );
  else if (d.canonical === d.url || d.canonical === d.finalUrl)
    out.push(
      mkCheck(
        "seo",
        "canonical",
        "Canonical URL",
        "pass",
        "Self-referencing",
        "",
        "",
      ),
    );
  else
    out.push(
      mkCheck(
        "seo",
        "canonical",
        "Canonical URL",
        "warn",
        "Points elsewhere",
        "Confirm this page should defer to another URL.",
        "Wrong canonical de-indexes the page.",
      ),
    );
  if (d.canonical && !/^https?:\/\//i.test(d.canonical)) {
    out.push(
      mkCheck(
        "seo",
        "canonAbs",
        "Canonical is absolute",
        "fail",
        "Relative URL",
        "Use a full https:// URL.",
        "Crawlers may misinterpret relatives.",
      ),
    );
  }

  if (/noindex/i.test(d.robots))
    out.push(
      mkCheck(
        "seo",
        "robots",
        "Robots directive",
        "fail",
        "noindex",
        "Remove noindex if this page should be indexed.",
        "Page invisible to search & AI.",
      ),
    );
  else if (/nofollow/i.test(d.robots))
    out.push(
      mkCheck(
        "seo",
        "robots",
        "Robots directive",
        "warn",
        "nofollow",
        "Confirm intent — outgoing link equity is dropped.",
        "Nofollow blocks crawl of links.",
      ),
    );
  else
    out.push(
      mkCheck(
        "seo",
        "robots",
        "Robots directive",
        "pass",
        d.robots || "Default (index, follow)",
        "",
        "",
      ),
    );

  if (!d.lang)
    out.push(
      mkCheck(
        "seo",
        "lang",
        "HTML lang attribute",
        "warn",
        "Missing",
        'Set <html lang="en"> (or actual locale).',
        "Helps search/AI choose correct locale.",
      ),
    );
  else
    out.push(
      mkCheck("seo", "lang", "HTML lang attribute", "pass", d.lang, "", ""),
    );

  if (!d.viewport)
    out.push(
      mkCheck(
        "seo",
        "viewport",
        "Viewport meta",
        "fail",
        "Missing",
        'Add <meta name="viewport" content="width=device-width,initial-scale=1">.',
        "Mobile-friendliness signal.",
      ),
    );
  else if (!/width\s*=\s*device-width/i.test(d.viewport))
    out.push(
      mkCheck(
        "seo",
        "viewport",
        "Viewport meta",
        "warn",
        d.viewport,
        "Include width=device-width.",
        "Layout will break on mobile.",
      ),
    );
  else
    out.push(
      mkCheck("seo", "viewport", "Viewport meta", "pass", d.viewport, "", ""),
    );

  if (!d.charset)
    out.push(
      mkCheck(
        "seo",
        "charset",
        "Character set",
        "warn",
        "Missing",
        'Declare <meta charset="utf-8">.',
        "Prevents encoding bugs.",
      ),
    );
  else
    out.push(
      mkCheck("seo", "charset", "Character set", "pass", d.charset, "", ""),
    );

  if (!d.favicon)
    out.push(
      mkCheck(
        "seo",
        "favicon",
        "Favicon",
        "warn",
        "Missing",
        'Add <link rel="icon" href="…">.',
        "Brand recall in tabs & SERP.",
      ),
    );
  else
    out.push(mkCheck("seo", "favicon", "Favicon", "pass", "Present", "", ""));

  return out;
}

function checkHeadings(d) {
  const out = [];
  const counts = [0, 0, 0, 0, 0, 0, 0];
  d.headings.forEach((h) => counts[h.level]++);
  const h1 = counts[1];

  if (h1 === 0)
    out.push(
      mkCheck(
        "content",
        "h1count",
        "Single H1",
        "fail",
        "No H1",
        "Add exactly one descriptive <h1>.",
        "H1 is the main topic signal.",
      ),
    );
  else if (h1 === 1)
    out.push(
      mkCheck("content", "h1count", "Single H1", "pass", "1 H1", "", ""),
    );
  else
    out.push(
      mkCheck(
        "content",
        "h1count",
        "Single H1",
        "warn",
        `${h1} H1s`,
        "Use only one H1; demote the rest to H2.",
        "Multiple H1s dilute topic clarity.",
      ),
    );

  const empty = d.headings.filter((h) => !h.text).length;
  if (empty)
    out.push(
      mkCheck(
        "content",
        "hempty",
        "No empty headings",
        "fail",
        `${empty} empty`,
        "Remove or fill empty heading tags.",
        "Empty headings break document outline.",
      ),
    );
  else if (d.headings.length)
    out.push(
      mkCheck(
        "content",
        "hempty",
        "No empty headings",
        "pass",
        "All filled",
        "",
        "",
      ),
    );

  let prev = 0,
    skipped = 0;
  d.headings.forEach((h) => {
    if (prev && h.level > prev + 1) skipped++;
    prev = h.level;
  });
  if (d.headings.length >= 2) {
    if (skipped)
      out.push(
        mkCheck(
          "content",
          "hskip",
          "Heading order",
          "warn",
          `${skipped} skipped levels`,
          "Avoid jumping levels (e.g., H2 → H4).",
          "Confuses outline parsers & screen readers.",
        ),
      );
    else
      out.push(
        mkCheck(
          "content",
          "hskip",
          "Heading order",
          "pass",
          "No skipped levels",
          "",
          "",
        ),
      );
  }

  const h1Text = d.headings.find((h) => h.level === 1)?.text || "";
  if (h1Text && d.title && h1Text.trim() === d.title.trim()) {
    out.push(
      mkCheck(
        "content",
        "h1dup",
        "H1 vs Title",
        "warn",
        "Identical text",
        "Vary phrasing slightly to capture more keywords.",
        "Distinct H1/title broadens query coverage.",
      ),
    );
  } else if (h1Text) {
    out.push(
      mkCheck("content", "h1dup", "H1 vs Title", "pass", "Differ", "", ""),
    );
  }

  const h2 = counts[2];
  if (d.headings.length >= 6 && h2 < 2) {
    out.push(
      mkCheck(
        "content",
        "h2",
        "H2 sectioning",
        "warn",
        `${h2} H2(s)`,
        "Break content into ≥2 H2 sections.",
        "Section headings help passage retrieval.",
      ),
    );
  } else if (d.headings.length >= 2) {
    out.push(
      mkCheck("content", "h2", "H2 sectioning", "pass", `${h2} H2(s)`, "", ""),
    );
  }

  return out;
}

function checkLinks(d) {
  const out = [];
  const internal = d.links.filter((l) => l.internal);
  const external = d.links.filter((l) => !l.internal);

  if (internal.length >= 3)
    out.push(
      mkCheck(
        "links",
        "internal",
        "Internal links",
        "pass",
        `${internal.length} internal`,
        "",
        "",
      ),
    );
  else if (internal.length >= 1)
    out.push(
      mkCheck(
        "links",
        "internal",
        "Internal links",
        "warn",
        `${internal.length} internal`,
        "Add ≥3 contextual internal links.",
        "Distributes authority & helps crawl.",
      ),
    );
  else
    out.push(
      mkCheck(
        "links",
        "internal",
        "Internal links",
        "fail",
        "None",
        "Link to related pages on your site.",
        "Orphan pages rank poorly.",
      ),
    );

  const emptyAnchors = d.links.filter((l) => !l.anchor).length;
  if (emptyAnchors === 0 && d.links.length)
    out.push(
      mkCheck(
        "links",
        "anchor",
        "Anchor text present",
        "pass",
        "All links have anchor text",
        "",
        "",
      ),
    );
  else if (emptyAnchors)
    out.push(
      mkCheck(
        "links",
        "anchor",
        "Anchor text present",
        "warn",
        `${emptyAnchors} empty`,
        'Add descriptive anchor text (avoid "click here").',
        "Anchors are ranking & accessibility signals.",
      ),
    );

  const unsafeBlank = d.links.filter(
    (l) => l.target === "_blank" && !/noopener/i.test(l.rel),
  ).length;
  if (d.links.some((l) => l.target === "_blank")) {
    if (unsafeBlank === 0)
      out.push(
        mkCheck(
          "links",
          "noopener",
          'target="_blank" safety',
          "pass",
          "All use rel=noopener",
          "",
          "",
        ),
      );
    else
      out.push(
        mkCheck(
          "links",
          "noopener",
          'target="_blank" safety',
          "warn",
          `${unsafeBlank} missing rel=noopener`,
          'Add rel="noopener noreferrer" on target="_blank" links.',
          "Prevents reverse tabnabbing & perf hit.",
        ),
      );
  }

  if (external.length >= 4) {
    const nf = external.filter((l) => /nofollow/i.test(l.rel)).length;
    const ratio = nf / external.length;
    if (ratio > 0.5)
      out.push(
        mkCheck(
          "links",
          "nofollow",
          "External nofollow ratio",
          "warn",
          `${Math.round(ratio * 100)}% nofollow`,
          "Reserve nofollow for sponsored/UGC.",
          "Over-nofollow strips authority signals.",
        ),
      );
    else
      out.push(
        mkCheck(
          "links",
          "nofollow",
          "External nofollow ratio",
          "pass",
          `${Math.round(ratio * 100)}% nofollow`,
          "",
          "",
        ),
      );
  }

  return out;
}

function checkMedia(d) {
  const out = [];
  const imgs = d.images.filter((i) => i.kind === "image");
  if (!imgs.length) {
    out.push(
      mkCheck(
        "media",
        "alt",
        "Image alt coverage",
        "info",
        "No <img> tags",
        "",
        "Nothing to evaluate.",
      ),
    );
    return out;
  }
  const withAlt = imgs.filter((i) => i.alt && i.alt.trim()).length;
  const cov = withAlt / imgs.length;
  const pct = Math.round(cov * 100);
  if (cov >= 0.9)
    out.push(
      mkCheck(
        "media",
        "alt",
        "Image alt coverage",
        "pass",
        `${pct}% (${withAlt}/${imgs.length})`,
        "",
        "",
      ),
    );
  else if (cov >= 0.6)
    out.push(
      mkCheck(
        "media",
        "alt",
        "Image alt coverage",
        "warn",
        `${pct}% (${withAlt}/${imgs.length})`,
        "Add alt text to remaining images.",
        "Alt is read by AI, screen readers, & ranks images.",
      ),
    );
  else
    out.push(
      mkCheck(
        "media",
        "alt",
        "Image alt coverage",
        "fail",
        `${pct}% (${withAlt}/${imgs.length})`,
        "Add descriptive alt text to most images.",
        "Critical accessibility & AEO signal.",
      ),
    );

  const alts = imgs.map((i) => (i.alt || "").trim()).filter(Boolean);
  if (alts.length) {
    const avgWords =
      alts.reduce((s, a) => s + a.split(/\s+/).length, 0) / alts.length;
    if (avgWords >= 3)
      out.push(
        mkCheck(
          "media",
          "altRich",
          "Alt text descriptiveness",
          "pass",
          `avg ${avgWords.toFixed(1)} words`,
          "",
          "",
        ),
      );
    else
      out.push(
        mkCheck(
          "media",
          "altRich",
          "Alt text descriptiveness",
          "warn",
          `avg ${avgWords.toFixed(1)} words`,
          "Use descriptive alts (≥3 words).",
          "Single-word alts under-describe images for AI ingestion.",
        ),
      );
  }

  const oversized = imgs.filter((i) => i.w > 2400).length;
  if (oversized)
    out.push(
      mkCheck(
        "media",
        "size",
        "Image dimensions",
        "warn",
        `${oversized} oversized (>2400px wide)`,
        "Serve responsive sizes via srcset.",
        "Bloated images hurt LCP/Core Web Vitals.",
      ),
    );
  else
    out.push(
      mkCheck(
        "media",
        "size",
        "Image dimensions",
        "pass",
        "All within reasonable size",
        "",
        "",
      ),
    );

  return out;
}

function checkSchema(d) {
  const out = [];
  const items = flattenSchema(d.schema);
  if (!items.length) {
    out.push(
      mkCheck(
        "schema",
        "present",
        "JSON-LD present",
        "fail",
        "No structured data",
        "Add JSON-LD (Article/Product/FAQPage/HowTo/Organization).",
        "Schema is the strongest AEO surface.",
      ),
    );
    return out;
  }
  out.push(
    mkCheck(
      "schema",
      "present",
      "JSON-LD present",
      "pass",
      `${items.length} block(s)`,
      "",
      "",
    ),
  );

  const types = schemaTypes(items);
  const primaryTypes = [
    "Article",
    "NewsArticle",
    "BlogPosting",
    "Product",
    "FAQPage",
    "HowTo",
    "Organization",
    "WebSite",
    "WebPage",
  ];
  const hasPrimary = primaryTypes.some((t) => types.has(t));
  if (hasPrimary)
    out.push(
      mkCheck(
        "schema",
        "primary",
        "Page-type schema",
        "pass",
        [...types].slice(0, 4).join(", "),
        "",
        "",
      ),
    );
  else
    out.push(
      mkCheck(
        "schema",
        "primary",
        "Page-type schema",
        "warn",
        [...types].slice(0, 4).join(", ") || "—",
        "Add a primary type (Article/Product/etc.).",
        "Generic types limit rich-result eligibility.",
      ),
    );

  const articles = ["Article", "NewsArticle", "BlogPosting"].flatMap((t) =>
    findSchemaByType(items, t),
  );
  if (articles.length) {
    const a = articles[0];
    const missing = ["headline", "author", "datePublished", "image"].filter(
      (k) => !a[k],
    );
    if (!missing.length)
      out.push(
        mkCheck(
          "schema",
          "article",
          "Article fields complete",
          "pass",
          "headline, author, datePublished, image",
          "",
          "",
        ),
      );
    else
      out.push(
        mkCheck(
          "schema",
          "article",
          "Article fields complete",
          "fail",
          `missing: ${missing.join(", ")}`,
          "Add missing fields to Article schema.",
          "Required for Top Stories & rich results.",
        ),
      );
  }

  const products = findSchemaByType(items, "Product");
  if (products.length) {
    const p = products[0];
    const offers = p.offers || {};
    const missing = [];
    if (!p.name) missing.push("name");
    if (!p.image) missing.push("image");
    if (!offers.price) missing.push("offers.price");
    if (!offers.priceCurrency) missing.push("offers.priceCurrency");
    if (!missing.length)
      out.push(
        mkCheck(
          "schema",
          "product",
          "Product fields complete",
          "pass",
          "name, image, offers.price, currency",
          "",
          "",
        ),
      );
    else
      out.push(
        mkCheck(
          "schema",
          "product",
          "Product fields complete",
          "fail",
          `missing: ${missing.join(", ")}`,
          "Fill required Product/Offer fields.",
          "Needed for Merchant rich results.",
        ),
      );
  }

  const faqs = findSchemaByType(items, "FAQPage");
  if (faqs.length) {
    const f = faqs[0];
    const me = Array.isArray(f.mainEntity)
      ? f.mainEntity
      : f.mainEntity
        ? [f.mainEntity]
        : [];
    const valid = me.filter((q) => q?.acceptedAnswer?.text).length;
    if (valid >= 1)
      out.push(
        mkCheck(
          "schema",
          "faq",
          "FAQPage answers",
          "pass",
          `${valid} Q&A pair(s)`,
          "",
          "",
        ),
      );
    else
      out.push(
        mkCheck(
          "schema",
          "faq",
          "FAQPage answers",
          "fail",
          "No acceptedAnswer.text",
          "Each Question needs acceptedAnswer.text.",
          "Required for FAQ rich result.",
        ),
      );
  }

  const howtos = findSchemaByType(items, "HowTo");
  if (howtos.length) {
    const h = howtos[0];
    if (h.name && Array.isArray(h.step) && h.step.length)
      out.push(
        mkCheck(
          "schema",
          "howto",
          "HowTo steps",
          "pass",
          `${h.step.length} step(s)`,
          "",
          "",
        ),
      );
    else
      out.push(
        mkCheck(
          "schema",
          "howto",
          "HowTo steps",
          "fail",
          "Missing name or step[]",
          "Add name + step[] with HowToStep items.",
          "Required for HowTo rich result.",
        ),
      );
  }

  const orgs = findSchemaByType(items, "Organization");
  if (orgs.length) {
    const o = orgs[0];
    const missing = ["name", "url", "logo"].filter((k) => !o[k]);
    if (!missing.length)
      out.push(
        mkCheck(
          "schema",
          "org",
          "Organization fields",
          "pass",
          "name, url, logo",
          "",
          "",
        ),
      );
    else
      out.push(
        mkCheck(
          "schema",
          "org",
          "Organization fields",
          "warn",
          `missing: ${missing.join(", ")}`,
          "Add missing Organization fields.",
          "Knowledge-panel & E-E-A-T signal.",
        ),
      );
  }

  const bc = findSchemaByType(items, "BreadcrumbList");
  if (bc.length)
    out.push(
      mkCheck(
        "schema",
        "crumb",
        "Breadcrumb schema",
        "pass",
        "Present",
        "",
        "",
      ),
    );
  else
    out.push(
      mkCheck(
        "schema",
        "crumb",
        "Breadcrumb schema",
        "warn",
        "Not found",
        "Add BreadcrumbList for hierarchical pages.",
        "Improves SERP path display.",
      ),
    );

  return out;
}

function checkSocial(d) {
  const out = [];
  const need = ["og:title", "og:description", "og:image", "og:url", "og:type"];
  const missing = need.filter((k) => !d.og[k]);
  if (!missing.length)
    out.push(
      mkCheck(
        "social",
        "og",
        "Open Graph complete",
        "pass",
        "title, description, image, url, type",
        "",
        "",
      ),
    );
  else if (missing.length <= 2)
    out.push(
      mkCheck(
        "social",
        "og",
        "Open Graph complete",
        "warn",
        `missing: ${missing.join(", ")}`,
        "Fill missing og:* tags.",
        "Drives social previews & some AI fetchers.",
      ),
    );
  else
    out.push(
      mkCheck(
        "social",
        "og",
        "Open Graph complete",
        "fail",
        `missing: ${missing.join(", ")}`,
        "Add the core og:* tags.",
        "Without these, link unfurls look broken.",
      ),
    );

  const tcard = d.twitter["twitter:card"];
  if (tcard)
    out.push(
      mkCheck("social", "twcard", "Twitter Card", "pass", tcard, "", ""),
    );
  else
    out.push(
      mkCheck(
        "social",
        "twcard",
        "Twitter Card",
        "warn",
        "Missing",
        'Add <meta name="twitter:card" content="summary_large_image">.',
        "Controls X/Twitter preview style.",
      ),
    );

  return out;
}

function checkAEO(d) {
  const out = [];
  const items = flattenSchema(d.schema);
  const types = schemaTypes(items);

  const qHeadings = d.headings.filter((h) =>
    /^(how|what|why|when|where|who|can|does|is|are|should)\b.*\?$/i.test(
      h.text,
    ),
  );
  const hasFAQ = types.has("FAQPage");
  if (hasFAQ)
    out.push(
      mkCheck(
        "aeo",
        "faq",
        "FAQ signal",
        "pass",
        "FAQPage schema present",
        "",
        "",
      ),
    );
  else if (qHeadings.length >= 2)
    out.push(
      mkCheck(
        "aeo",
        "faq",
        "FAQ signal",
        "pass",
        `${qHeadings.length} question heading(s)`,
        "",
        "",
      ),
    );
  else
    out.push(
      mkCheck(
        "aeo",
        "faq",
        "FAQ signal",
        "warn",
        "No FAQ structure",
        "Add Q&A sections (question-shaped H2/H3 + concise answers) or FAQPage schema.",
        "Answer engines lift Q&A pairs verbatim.",
      ),
    );

  const hasHowTo = types.has("HowTo");
  if (hasHowTo)
    out.push(
      mkCheck(
        "aeo",
        "howto",
        "HowTo signal",
        "pass",
        "HowTo schema present",
        "",
        "",
      ),
    );
  else
    out.push(
      mkCheck(
        "aeo",
        "howto",
        "HowTo signal",
        "warn",
        "No HowTo schema",
        "For procedural content, add HowTo + step[] schema.",
        "Procedural answers get cited as steps.",
      ),
    );

  const articles = ["Article", "NewsArticle", "BlogPosting"].flatMap((t) =>
    findSchemaByType(items, t),
  );
  const a = articles[0];
  const hasAuthor =
    !!a?.author ||
    !!(d.meta || []).find((m) => /^(author|article:author)$/i.test(m.key));
  const hasDate =
    !!a?.datePublished ||
    !!(d.meta || []).find((m) =>
      /^(article:published_time|datePublished)$/i.test(m.key),
    );
  if (hasAuthor && hasDate)
    out.push(
      mkCheck(
        "aeo",
        "authority",
        "Authorship & date",
        "pass",
        "Author + datePublished",
        "",
        "",
      ),
    );
  else {
    const miss = [];
    if (!hasAuthor) miss.push("author");
    if (!hasDate) miss.push("datePublished");
    out.push(
      mkCheck(
        "aeo",
        "authority",
        "Authorship & date",
        "warn",
        `missing: ${miss.join(", ")}`,
        "Expose author + datePublished (schema or article:* meta).",
        "E-E-A-T & freshness drive AI citation.",
      ),
    );
  }

  const dm =
    a?.dateModified ||
    (d.meta || []).find((m) => /article:modified_time/i.test(m.key))?.value;
  if (dm) {
    const t = Date.parse(dm);
    if (!isNaN(t)) {
      const months = (Date.now() - t) / (1000 * 60 * 60 * 24 * 30);
      if (months <= 18)
        out.push(
          mkCheck(
            "aeo",
            "recency",
            "Recency (dateModified)",
            "pass",
            `${months.toFixed(0)} months ago`,
            "",
            "",
          ),
        );
      else
        out.push(
          mkCheck(
            "aeo",
            "recency",
            "Recency (dateModified)",
            "warn",
            `${months.toFixed(0)} months ago`,
            "Refresh & update dateModified.",
            "AI prefers recent sources.",
          ),
        );
    }
  }

  const authority = d.links.filter(
    (l) => !l.internal && /\.(gov|edu|mil)(\/|$)/i.test(l.url),
  ).length;
  const reputed = d.links.filter(
    (l) => !l.internal && /\.(org|ac\.[a-z]{2})(\/|$)/i.test(l.url),
  ).length;
  if (authority + reputed >= 1)
    out.push(
      mkCheck(
        "aeo",
        "cite",
        "Authority citations",
        "pass",
        `${authority} .gov/.edu, ${reputed} .org/.ac`,
        "",
        "",
      ),
    );
  else
    out.push(
      mkCheck(
        "aeo",
        "cite",
        "Authority citations",
        "warn",
        "No .gov/.edu/.org outbound",
        "Cite primary authoritative sources where relevant.",
        "Citation graph supports trust.",
      ),
    );

  const ents = [
    ...findSchemaByType(items, "Organization"),
    ...findSchemaByType(items, "Person"),
  ];
  const hasSameAs = ents.some((e) =>
    Array.isArray(e.sameAs) ? e.sameAs.length : !!e.sameAs,
  );
  if (ents.length && hasSameAs)
    out.push(
      mkCheck(
        "aeo",
        "entity",
        "Entity sameAs links",
        "pass",
        "Organization/Person with sameAs",
        "",
        "",
      ),
    );
  else if (ents.length)
    out.push(
      mkCheck(
        "aeo",
        "entity",
        "Entity sameAs links",
        "warn",
        "Org/Person but no sameAs",
        "Add sameAs[] linking to Wikidata / LinkedIn / X / official profiles.",
        "Disambiguates entity for knowledge graphs.",
      ),
    );
  else
    out.push(
      mkCheck(
        "aeo",
        "entity",
        "Entity sameAs links",
        "warn",
        "No Organization/Person schema",
        "Add Organization (or Person for author) with sameAs[].",
        "Anchors content to a known entity.",
      ),
    );

  const hasSpeakable = items.some((i) => i?.speakable);
  if (hasSpeakable)
    out.push(
      mkCheck(
        "aeo",
        "speakable",
        "Speakable schema",
        "pass",
        "Present",
        "",
        "",
      ),
    );
  else
    out.push(
      mkCheck(
        "aeo",
        "speakable",
        "Speakable schema",
        "info",
        "Not used",
        "Optional: add speakable spec for voice surfaces.",
        "Enables voice-assistant readouts.",
      ),
    );

  const tq =
    /^(how|what|why|when|where|who|can|does|is|are|should)\b/i.test(d.title) ||
    /\?$/.test(d.title);
  if (tq)
    out.push(
      mkCheck(
        "aeo",
        "titleQ",
        "Title shaped for queries",
        "pass",
        "Question or query-shaped",
        "",
        "",
      ),
    );
  else
    out.push(
      mkCheck(
        "aeo",
        "titleQ",
        "Title shaped for queries",
        "info",
        "Statement title",
        "Consider question-shaped titles for informational pages.",
        "Matches user query patterns.",
      ),
    );

  return out;
}

function checkCrawl(d) {
  const out = [];
  const xr = (d.meta || []).find(
    (m) => m.kind === "http-equiv" && /^x-robots-tag$/i.test(m.key),
  );
  if (xr && /noindex/i.test(xr.value))
    out.push(
      mkCheck(
        "crawl",
        "xrobots",
        "X-Robots-Tag",
        "fail",
        xr.value,
        "Remove noindex from X-Robots-Tag.",
        "Page blocked from index.",
      ),
    );
  else if (xr)
    out.push(
      mkCheck("crawl", "xrobots", "X-Robots-Tag", "pass", xr.value, "", ""),
    );

  if (d.hreflang && d.hreflang.length) {
    const broken = d.hreflang.filter((h) => !h.lang || !h.href).length;
    if (!broken)
      out.push(
        mkCheck(
          "crawl",
          "hreflang",
          "Hreflang shape",
          "pass",
          `${d.hreflang.length} alternate(s)`,
          "",
          "",
        ),
      );
    else
      out.push(
        mkCheck(
          "crawl",
          "hreflang",
          "Hreflang shape",
          "warn",
          `${broken} malformed`,
          "Each alternate needs hreflang + href.",
          "Malformed entries are ignored.",
        ),
      );
  }

  if (!/noindex/i.test(d.robots))
    out.push(
      mkCheck(
        "crawl",
        "indexable",
        "Indexable",
        "pass",
        "No noindex blocking",
        "",
        "",
      ),
    );
  else
    out.push(
      mkCheck(
        "crawl",
        "indexable",
        "Indexable",
        "fail",
        "noindex",
        "Remove noindex.",
        "Page hidden from search.",
      ),
    );

  return out;
}

function runAnalysis(d) {
  const checkFns = {
    seo: checkSEOBasics,
    content: checkHeadings,
    links: checkLinks,
    media: checkMedia,
    schema: checkSchema,
    social: checkSocial,
    aeo: checkAEO,
    crawl: checkCrawl,
  };
  const allChecks = [];
  const cats = ANALYSIS_CATEGORIES.map((c) => {
    const checks = checkFns[c.id](d) || [];
    allChecks.push(...checks);
    const scoring = checks.filter((k) => k.status !== "info");
    const score = scoring.length
      ? scoring.reduce((s, k) => s + k.score, 0) / scoring.length
      : 100;
    const pass = checks.filter((k) => k.status === "pass").length;
    const warn = checks.filter((k) => k.status === "warn").length;
    const fail = checks.filter((k) => k.status === "fail").length;
    const info = checks.filter((k) => k.status === "info").length;
    return { ...c, checks, score: Math.round(score), pass, warn, fail, info };
  });
  const totalW = cats.reduce((s, c) => s + c.weight, 0);
  const overall = Math.round(
    cats.reduce((s, c) => s + c.score * c.weight, 0) / totalW,
  );
  const grade =
    overall >= 90
      ? "A"
      : overall >= 80
        ? "B"
        : overall >= 70
          ? "C"
          : overall >= 60
            ? "D"
            : "F";
  const totals = {
    pass: allChecks.filter((k) => k.status === "pass").length,
    warn: allChecks.filter((k) => k.status === "warn").length,
    fail: allChecks.filter((k) => k.status === "fail").length,
    info: allChecks.filter((k) => k.status === "info").length,
  };
  return { overall, grade, cats, totals, checks: allChecks };
}

function statusIcon(status) {
  if (status === "pass")
    return `<span class="ck-icon ok" aria-label="Pass">${ICONS.check}</span>`;
  if (status === "warn")
    return `<span class="ck-icon warn" aria-label="Warning">${ICONS.warn}</span>`;
  if (status === "fail")
    return `<span class="ck-icon fail" aria-label="Fail"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg></span>`;
  return `<span class="ck-icon info" aria-label="Info"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg></span>`;
}

function verdictText(overall, totals) {
  if (overall >= 90) return "Excellent — minor polish only.";
  if (overall >= 80) return "Solid foundation, a few items to tighten.";
  if (overall >= 70) return "Reasonable — several gaps to close.";
  if (overall >= 60) return "Mixed — meaningful work remains.";
  return totals.fail > totals.warn
    ? "Significant gaps blocking visibility."
    : "Multiple weak signals to address.";
}

function checkRowHTML(k) {
  const hasMore = !!(k.fix || k.why);
  const cat =
    ANALYSIS_CATEGORIES.find((c) => c.id === k.category)?.label || k.category;
  return `
    <div class="ck-row ${k.status}">
      <div class="ck-head">
        ${statusIcon(k.status)}
        <div class="ck-main">
          <div class="ck-label">${escapeHtml(k.label)}</div>
          ${k.detail ? `<div class="ck-detail">${escapeHtml(k.detail)}</div>` : ""}
        </div>
        <span class="ck-cat">${escapeHtml(cat)}</span>
        ${hasMore ? `<button type="button" class="ck-more" data-ck-toggle aria-label="Show details">▾</button>` : ""}
      </div>
      ${
        hasMore
          ? `
      <div class="ck-body">
        ${k.fix ? `<div class="ck-fix"><b>Fix:</b> ${escapeHtml(k.fix)}</div>` : ""}
        ${k.why ? `<div class="ck-why"><b>Why:</b> ${escapeHtml(k.why)}</div>` : ""}
      </div>`
          : ""
      }
    </div>`;
}

function renderAnalysis() {
  const result = runAnalysis(state.data);
  const { overall, grade, cats, totals, checks } = result;

  const ringPct = overall;
  const dash = ((ringPct / 100) * 2 * Math.PI * 34).toFixed(2);
  const tone = overall >= 85 ? "ok" : overall >= 65 ? "warn" : "fail";

  const hero = `
    <div class="score-hero">
      <div class="score-ring ${tone}">
        <svg viewBox="0 0 80 80" aria-hidden="true">
          <circle class="ring-bg" cx="40" cy="40" r="34"></circle>
          <circle class="ring-fg" cx="40" cy="40" r="34"
            stroke-dasharray="${dash} 999"></circle>
        </svg>
        <div class="ring-center">
          <span class="ring-num">${overall}</span>
          <span class="ring-grade grade-${grade}">${grade}</span>
        </div>
      </div>
      <div class="score-meta">
        <h2>SEO &amp; AEO Score</h2>
        <p class="verdict">${escapeHtml(verdictText(overall, totals))}</p>
        <div class="score-totals">
          <button type="button" class="totalchip ok"   data-af="passed"  aria-pressed="${state.analysisFilter === "passed"}">${ICONS.check}<b>${totals.pass}</b> passed</button>
          <button type="button" class="totalchip warn" data-af="warning" aria-pressed="${state.analysisFilter === "warning"}">${ICONS.warn}<b>${totals.warn}</b> warnings</button>
          <button type="button" class="totalchip fail" data-af="failing" aria-pressed="${state.analysisFilter === "failing"}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg><b>${totals.fail}</b> failed</button>
          ${totals.info ? `<span class="totalchip info"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v5h1"/></svg><b>${totals.info}</b> info</span>` : ""}
        </div>
      </div>
    </div>`;

  const catsHTML =
    `<div class="cats">` +
    cats
      .map((c) => {
        const expanded = state.analysisExpanded.has(c.id);
        const tone2 = c.score >= 85 ? "ok" : c.score >= 65 ? "warn" : "fail";
        const inner = expanded
          ? `<div class="cat-checks">` +
            c.checks.map(checkRowHTML).join("") +
            `</div>`
          : "";
        return `
      <div class="cat" data-cat="${c.id}">
        <button type="button" class="cat-row" data-cat-toggle="${c.id}" aria-expanded="${expanded}">
          <span class="cat-name">${escapeHtml(c.label)}</span>
          <span class="cat-bar"><span class="cat-bar-fill ${tone2}" style="width:${c.score}%"></span></span>
          <span class="cat-score ${tone2}">${c.score}</span>
          <span class="cat-counts">
            ${c.pass ? `<span class="cnt ok">${c.pass}</span>` : ""}
            ${c.warn ? `<span class="cnt warn">${c.warn}</span>` : ""}
            ${c.fail ? `<span class="cnt fail">${c.fail}</span>` : ""}
          </span>
          <span class="cat-chev ${expanded ? "open" : ""}" aria-hidden="true">▾</span>
        </button>
        ${inner}
      </div>`;
      })
      .join("") +
    `</div>`;

  const filter = state.analysisFilter;
  const filtered = checks.filter((k) => {
    if (filter === "all") return true;
    if (filter === "passed") return k.status === "pass";
    if (filter === "warning") return k.status === "warn";
    if (filter === "failing") return k.status === "fail";
    return true;
  });
  const order = { fail: 0, warn: 1, info: 2, pass: 3 };
  filtered.sort((a, b) => order[a.status] - order[b.status]);

  const filterChips = `
    <div class="analysis-filter">
      <button class="chip" data-af="all"     aria-pressed="${filter === "all"}"     type="button">All <span class="count">${checks.length}</span></button>
      <button class="chip" data-af="failing" aria-pressed="${filter === "failing"}" type="button"><span class="dot fail"></span>Failing <span class="count">${totals.fail}</span></button>
      <button class="chip" data-af="warning" aria-pressed="${filter === "warning"}" type="button"><span class="dot warn"></span>Warnings <span class="count">${totals.warn}</span></button>
      <button class="chip" data-af="passed"  aria-pressed="${filter === "passed"}"  type="button"><span class="dot ok"></span>Passed <span class="count">${totals.pass}</span></button>
    </div>`;

  const list = filtered.length
    ? `<div class="checklist">${filtered.map(checkRowHTML).join("")}</div>`
    : `<div class="empty"><span class="em">Nothing here.</span>No checks match this filter.</div>`;

  const html = `
    ${hero}
    <h3 class="analysis-section">Categories</h3>
    ${catsHTML}
    <h3 class="analysis-section">Checklist</h3>
    ${filterChips}
    ${list}
  `;

  const panel = $("#tab-analysis");
  panel.replaceChildren(elt("div", "analysis", html));

  panel.querySelectorAll("[data-af]").forEach((b) => {
    b.addEventListener("click", () => {
      state.analysisFilter = b.dataset.af;
      renderAnalysis();
    });
  });
  panel.querySelectorAll("[data-cat-toggle]").forEach((b) => {
    b.addEventListener("click", () => {
      const id = b.dataset.catToggle;
      if (state.analysisExpanded.has(id)) state.analysisExpanded.delete(id);
      else state.analysisExpanded.add(id);
      renderAnalysis();
    });
  });
  panel.querySelectorAll("[data-ck-toggle]").forEach((b) => {
    b.addEventListener("click", () => {
      const row = b.closest(".ck-row");
      if (row) row.classList.toggle("open");
    });
  });
}

// =============================================================
// Delegated actions (image actions)
// =============================================================
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  // prevent <summary> toggle when clicking action buttons inside it
  if (btn.closest("summary")) e.preventDefault();
  const act = btn.dataset.act;

  // generic copy
  if (act === "copy-text") {
    const text = btn.dataset.copy ?? "";
    try {
      await navigator.clipboard.writeText(text);
      flashSuccess(btn, "Copied");
    } catch {
      flash(btn, "Failed");
    }
    return;
  }
  // generic download by URL
  if (act === "dl-url") {
    const url = btn.dataset.url;
    const filename = btn.dataset.filename || guessFilename(url);
    if (url)
      chrome.downloads
        .download({ url, filename: safeFilename(filename), saveAs: false })
        .catch(() => {});
    flashSuccess(btn, "Downloading");
    return;
  }
  // generic open in tab
  if (act === "open-url") {
    const url = btn.dataset.url;
    if (url) chrome.tabs.create({ url });
    return;
  }

  // image-row actions
  const i = Number(btn.dataset.i);
  const img = state.data?.images?.[i];
  if (!img) return;
  if (act === "img-copy") {
    if (img.kind !== "image") {
      // clipboards don't accept video/audio bitmaps — copy the URL instead
      try {
        await navigator.clipboard.writeText(img.src);
        flashSuccess(btn, "Copied URL");
      } catch {
        flash(btn, "Failed");
      }
    } else {
      flash(btn, "Copying…");
      try {
        await copyImageBitmap(img.src);
        flashSuccess(btn, "Copied image");
      } catch {
        try {
          await navigator.clipboard.writeText(img.src);
          flashSuccess(btn, "Copied URL");
        } catch {
          flash(btn, "Failed");
        }
      }
    }
  } else if (act === "img-open") {
    chrome.tabs.create({ url: img.src });
  } else if (act === "img-dl") {
    downloadImg(img);
    flashSuccess(btn, "Downloading");
  }
});

function flashSuccess(el, msg) {
  const originalTitle =
    el.getAttribute("title") || el.getAttribute("aria-label") || "";
  const originalHTML = el.innerHTML;
  el.classList.add("ok");
  el.innerHTML = `${ICONS.check}<span class="sr-only">${escapeHtml(msg)}</span>`;
  el.setAttribute("title", msg);
  el.setAttribute("aria-label", msg);
  setTimeout(() => {
    el.classList.remove("ok");
    el.innerHTML = originalHTML;
    el.setAttribute("title", originalTitle);
    el.setAttribute("aria-label", originalTitle);
  }, 1100);
}

function safeFilename(n) {
  return (
    String(n || "file")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .slice(0, 180) || "file"
  );
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
  const resp = await fetch(src, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();

  if (blob.type === "image/png") {
    return navigator.clipboard.write([
      new ClipboardItem({ "image/png": blob }),
    ]);
  }

  // Decode → re-encode as PNG via OffscreenCanvas (or HTMLCanvas fallback).
  const objUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Image decode failed"));
      i.crossOrigin = "anonymous";
      i.src = objUrl;
    });
    const w = img.naturalWidth || img.width || 1;
    const h = img.naturalHeight || img.height || 1;

    let pngBlob;
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      pngBlob = await canvas.convertToBlob({ type: "image/png" });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      pngBlob = await new Promise((res) => canvas.toBlob(res, "image/png"));
      if (!pngBlob) throw new Error("Canvas encode failed");
    }
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": pngBlob }),
    ]);
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

function guessFilename(url) {
  try {
    const u = new URL(url);
    return decodeURIComponent(
      u.pathname.split("/").filter(Boolean).pop() || u.hostname,
    );
  } catch {
    return "file";
  }
}

function flash(el, msg) {
  el.setAttribute("title", msg);
  el.setAttribute("aria-label", msg);
  el.style.transform = "scale(0.92)";
  setTimeout(() => {
    el.style.transform = "";
  }, 600);
}

function showError(msg) {
  $("#loading").hidden = true;
  $("#error").hidden = false;
  if (msg) $("#errorMsg").textContent = msg;
}
