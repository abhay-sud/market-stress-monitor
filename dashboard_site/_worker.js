// Cloudflare Pages "advanced mode" worker (2026-11-15).
//
// Why: the page loads its data in the browser, so search crawlers and AI
// tools that read HTML without running JavaScript only saw "Loading…".
// This worker puts the latest reading into the HTML they receive and serves
// the same reading as plain text at /latest.md. Browsers get the same page
// as before; the client-side render replaces the inserted headline.
//
// Scope: _routes.json sends only "/", the tab pages (TAB_PAGES), "/sitemap.xml",
// "/feed.xml" (Atom) and "/latest.md" here; every other file
// is served as a plain static asset. It lives in dashboard_site (the Pages
// output folder) because the project has no root dir, so a functions/ folder
// would have to sit at the repo root.
//
// Fail-safe: any error or slow response from Supabase returns the untouched
// static page (or a 503 for /latest.md); this must never break the site.
//
// Reads only the public crash_checks table with the same publishable key the
// page already ships (protected by RLS + GRANT, not secrecy).

const SUPABASE_URL = "https://jophlgbijfahmytkrjly.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_DAU2BkfrG_3-LU_fFKW1og_yVasDG6d";
const SITE = "https://marketstress.org";
const CACHE_SECONDS = 600;
const CACHE_KEY = `${SITE}/__cache/latest-reading-v6`;
const FETCH_TIMEOUT_MS = 2000;

const LATEST_FIELDS = "run_at,vix_value,vix_color,hy_spread_bps,hy_spread_color,sp_drawdown_pct,sp_drawdown_color,treasury_10y_pct,treasury_10y_color,sahm_rule_value,sahm_rule_color,fed_pivot_signal,fed_pivot_color,red_count,confirmed_red_count,confirmation_state,wave_authorized,warsh_classification,warsh_hard_rules_active,dd_vix_band,crash_probability_pct";

// Same order, labels and formats as GATE_ROWS in index.html.
const INDICATORS = [
  { name: "VIX", short: "VIX", v: "vix_value", c: "vix_color", conf: "vix", fmt: (v) => v.toFixed(2) },
  { name: "High-yield credit spread", short: "high-yield spread", v: "hy_spread_bps", c: "hy_spread_color", conf: "hy_spread", fmt: (v) => `${Math.round(v)} bp` },
  { name: "S&P 500 drawdown from all-time high", short: "S&P 500 drawdown", v: "sp_drawdown_pct", c: "sp_drawdown_color", conf: "sp_drawdown", fmt: (v) => `${v.toFixed(2)}%` },
  { name: "10-year Treasury yield", short: "10-year Treasury yield", v: "treasury_10y_pct", c: "treasury_10y_color", conf: "treasury_10y", fmt: (v) => `${v.toFixed(2)}%` },
  { name: "Sahm rule", short: "Sahm rule", v: "sahm_rule_value", c: "sahm_rule_color", conf: "sahm_rule", fmt: (v) => v.toFixed(2) },
  { name: "Fed pivot signal", short: "Fed pivot signal", v: "fed_pivot_signal", c: "fed_pivot_color", conf: null, fmt: (v) => (v === "NONE" ? "no pivot" : String(v).toLowerCase()) },
];
// Copied from index.html (DD_VIX_BAND_LABELS / DD_VIX_HIT_RATE / ddVixReading).
const DD_VIX_BAND_LABELS = { LOW: "Low", TRANSITIONING: "Elevated", HIGH: "High" };
const DD_VIX_HIT_RATE = { LOW: "5%", TRANSITIONING: "17%", HIGH: "44%" };
function ddVixReading(row) {
  const dd = row.sp_drawdown_pct == null ? null : Number(row.sp_drawdown_pct);
  if (dd != null && dd >= 10) return { status: "ALREADY_BREACHED", band: null };
  if (row.dd_vix_band) return { status: "ELIGIBLE", band: row.dd_vix_band };
  const vix = row.vix_value == null ? null : Number(row.vix_value);
  if (dd == null || vix == null) return { status: "UNAVAILABLE", band: null };
  const score = dd + vix / 5;
  return { status: "ELIGIBLE", band: score >= 10 ? "HIGH" : score >= 8.5 ? "TRANSITIONING" : "LOW" };
}
const RUN_LABEL = /^\s*Full report(?:\s*\([^)]*\)|,[^.]*)\.\s+/i;
const DISCLAIMER = "For information only, not investment advice. A personal project: signals apply the author's own rules, plus some AI judgment, to public data. They are not recommendations or calibrated forecasts, and data can be delayed or wrong.";

// Tab pages (2026-11-17): the same index.html served at its own URL per tab,
// with its own title/description/canonical and that tab's panel unhidden, so
// each tab can be linked and indexed. TAB_PATHS / TAB_TITLES in index.html
// (and TAB_BRANDS, the header subtitle) mirror this; change them together. "/" keeps the static page's own tags.
const TAB_PAGES = {
  "/smart-money": {
    tab: "smartmoney",
    brand: "· Smart money: market positioning and 13F flows",
    crumb: "Smart Money",
    title: "Smart Money: market positioning and 13F flows · Market Stress Monitor",
    description: "Where the money is leaning: CFTC futures positioning, put/call and margin debt as percentiles, sector fund flows and 13F net buying. Not investment advice.",
  },
  "/macro": {
    tab: "macro",
    brand: "· Macro and fiscal: fiscal dominance, yield curve and financial stress",
    crumb: "Macro & Fiscal",
    title: "Macro & Fiscal: fiscal dominance, yield curve, financial stress · Market Stress Monitor",
    description: "The slower US backdrop: a real-data fiscal dominance checklist, the yield curve with term premium, and financial-stress and funding indicators. Not advice.",
  },
  "/views": {
    tab: "analysts",
    brand: "· Notable views: macro investors vs live data",
    crumb: "Notable Views",
    title: "Notable Views: macro investors' views vs live data · Market Stress Monitor",
    // Names are filled in from analyst_views.json (viewsDescription) when it loads.
    description: "Public views of well-known macro investors and economists on debt, rates, the Fed and markets, each linked, dated and checked against live data.",
  },
};
const TAB_PANELS = ["stressmonitor", "smartmoney", "macro", "analysts"];

// Security headers (2026-11-25, SEO audit). Set here because _headers does
// not apply to responses from _worker.js. The CSP limits framing, <base> and
// plugins only: the page relies on inline scripts and styles, so it does not
// restrict scripts. HSTS, nosniff and Referrer-Policy already come from the
// zone; nosniff is repeated so it holds even if that setting changes.
const SECURITY_HEADERS = {
  "content-security-policy": "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'",
  "x-frame-options": "SAMEORIGIN",
  "x-content-type-options": "nosniff",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

function withSecurityHeaders(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env, ctx) {
    return withSecurityHeaders(await route(request, env, ctx));
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/latest.md") return latestMarkdown(request, ctx);
  if (url.pathname === "/sitemap.xml") return sitemapXml(request, env, ctx);
  if (url.pathname === "/feed.xml") return atomFeed(request, ctx);
  // "/views/" -> "/views": one URL per tab.
  if (url.pathname.length > 1 && url.pathname.endsWith("/") && TAB_PAGES[url.pathname.replace(/\/+$/, "")]) {
    return Response.redirect(`${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`, 301);
  }
  const page = TAB_PAGES[url.pathname] ?? null;
  if (url.pathname !== "/" && !page) return env.ASSETS.fetch(request);
  if (request.method === "HEAD") return env.ASSETS.fetch(new Request(new URL("/", url).toString(), { method: "HEAD" }));
  if (request.method !== "GET") return env.ASSETS.fetch(request);

  // Fetch by URL only, so a browser's If-None-Match can't turn this into a
  // bodyless 304 for a page whose inserted text has since changed.
  const asset = await env.ASSETS.fetch(new Request(new URL("/", url).toString()));
  if (!asset.ok || !(asset.headers.get("content-type") || "").includes("text/html")) return asset;
  let data = null;
  try { data = await loadLatest(ctx); } catch (e) { data = null; }
  // Notable Views text comes from the static JSON, so it needs no Supabase.
  let views = null;
  let description = page?.description;
  // Macro & Fiscal: today's numbers in the description (search snippets
  // for e.g. "latest 5y5y inflation" showed the tab with no number).
  if (page?.tab === "macro" && data) {
    try { description = macroDescription(data) ?? description; } catch (e) { /* keep the static text */ }
  }
  if (page?.tab === "smartmoney" && data?.smart) {
    try { description = smartDescription(data.smart) ?? description; } catch (e) { /* keep the static text */ }
  }
  if (page?.tab === "analysts") {
    try {
      const r = await env.ASSETS.fetch(new Request(new URL("/analyst_views.json", url).toString()));
      if (r.ok) {
        const content = await r.json();
        views = viewsHtml(content);
        description = viewsDescription(content) ?? description;
      }
    } catch (e) { views = null; }
  }
  if (!data && !page) return asset;

  const headers = new Headers(asset.headers);
  headers.delete("etag");
  headers.delete("content-length");
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  let rw = new HTMLRewriter();
  if (data) {
    rw = rw
      .on("#stress-verdict", { element(el) { el.setInnerContent(verdictHtml(data), { html: true }); } })
      // The direct answer first (SEO audit 2026-11-25: no sentence stated
      // today's verdict with the band), then the static blurb, then the readings.
      .on("#site-summary", { element(el) {
        el.prepend(`<span class="answer">${escHtml(answerSentence(data))}</span> `, { html: true });
        el.append(` ${escHtml(readingLists(facts(data)))}`, { html: true });
      } });
    // The home page's description carries today's numbers, so search
    // snippets, AI answers built on them and link previews show the live
    // reading rather than a generic blurb (tab pages keep their own).
    if (!page) {
      const live = liveDescription(data);
      rw = rw
        .on('meta[name="description"]', { element(el) { el.setAttribute("content", live); } })
        .on('meta[property="og:description"]', { element(el) { el.setAttribute("content", live); } });
    }
  }
  rw = rw.on('script[type="application/ld+json"]', jsonLdRewrite(data?.row.run_at ?? null, page, url.pathname));
  if (page) {
    const canonical = `${SITE}${url.pathname}`;
    rw = rw
      .on("title", { element(el) { el.setInnerContent(page.title); } })
      .on("#brand-tab", { element(el) { el.setInnerContent(page.brand, { html: true }); } })
      .on("#horizon", { element(el) { el.setAttribute("data-tab", page.tab); } })
      .on('meta[name="description"]', { element(el) { el.setAttribute("content", description); } })
      .on('link[rel="canonical"]', { element(el) { el.setAttribute("href", canonical); } })
      .on('meta[property="og:url"]', { element(el) { el.setAttribute("content", canonical); } })
      .on('meta[property="og:title"]', { element(el) { el.setAttribute("content", page.title); } })
      .on('meta[property="og:description"]', { element(el) { el.setAttribute("content", description); } });
    for (const id of TAB_PANELS) {
      rw = rw.on(`#tab-${id}`, { element(el) { if (id === page.tab) el.removeAttribute("hidden"); else el.setAttribute("hidden", ""); } });
    }
    if (views) rw = rw.on("#analysts-wrap", { element(el) { el.setInnerContent(views, { html: true }); } });
    // Smart Money and Macro load everything in the browser, so without
    // this their HTML was 99% the home page's and Google left them out
    // ("Crawled - currently not indexed", 2026-11-24). Each verdict block
    // is replaced whole by the page's own render once its JavaScript runs.
    if (page.tab === "smartmoney") {
      let smartHtml = SMART_INTRO_HTML;
      if (data?.smart) { try { smartHtml = smartVerdictHtml(data.smart); } catch (e) { smartHtml = SMART_INTRO_HTML; } }
      rw = rw.on("#smart-verdict", { element(el) { el.setInnerContent(smartHtml, { html: true }); } });
    }
    if (page.tab === "macro") {
      let macroHtml = MACRO_INTRO_HTML;
      if (data) { try { macroHtml = macroVerdictHtml(data); } catch (e) { macroHtml = MACRO_INTRO_HTML; } }
      rw = rw.on("#macro-verdict", { element(el) { el.setInnerContent(macroHtml, { html: true }); } });
    }
  }
  return rw.transform(new Response(asset.body, { status: asset.status, headers }));
}

async function latestMarkdown(request, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  let data = null;
  try { data = await loadLatest(ctx); } catch (e) { data = null; }
  if (!data) {
    return new Response(`# Market Stress Monitor\n\nThe latest reading is temporarily unavailable. See ${SITE}/\n`, {
      status: 503, headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", "retry-after": "300" },
    });
  }
  return new Response(request.method === "HEAD" ? null : markdown(data), {
    headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": `public, max-age=${CACHE_SECONDS}`, link: `<${SITE}/>; rel="canonical"` },
  });
}

// Sitemap with real lastmod dates (2026-11-24): the three data tabs change
// with each report, /views when analyst_views.json is reviewed. Falls back
// to the static sitemap.xml if neither date is available.
async function sitemapXml(request, env, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") return env.ASSETS.fetch(request);
  let data = null;
  try { data = await loadLatest(ctx); } catch (e) { data = null; }
  let reviewed = null;
  try {
    const r = await env.ASSETS.fetch(new Request(new URL("/analyst_views.json", request.url).toString()));
    if (r.ok) reviewed = (await r.json()).last_reviewed ?? null;
  } catch (e) { reviewed = null; }
  if (!data && !reviewed) return env.ASSETS.fetch(request);
  const day = data ? new Date(data.row.run_at).toISOString().slice(0, 10) : null;
  const urls = [["/", day], ["/smart-money", day], ["/macro", day], ["/views", reviewed], ["/how-it-works", null]];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map(([p, d]) => `  <url>\n    <loc>${SITE}${p}</loc>\n${d ? `    <lastmod>${escHtml(d)}</lastmod>\n` : ""}  </url>\n`).join("")
    + "</urlset>\n";
  return new Response(request.method === "HEAD" ? null : body, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": `public, max-age=${CACHE_SECONDS}` },
  });
}

// ---- Atom feed (2026-11-25) -------------------------------------------------
//
// /feed.xml: one entry per ET weekday (that day's last run), last FEED_DAYS
// days. The entry id is the date, so the 10am, 6pm and report runs update
// the same entry instead of adding new ones. Code-made numbers only: no AI
// narrative. The title marks a change in confirmed RED count or risk band
// against the previous weekday.
const FEED_DAYS = 30;
const FEED_CACHE_KEY = `${SITE}/__cache/feed-v1`;
const FEED_FIELDS = "run_at,vix_value,vix_color,hy_spread_bps,hy_spread_color,sp_drawdown_pct,sp_drawdown_color,treasury_10y_pct,treasury_10y_color,sahm_rule_value,sahm_rule_color,fed_pivot_signal,fed_pivot_color,red_count,confirmed_red_count,confirmation_state,wave_authorized,dd_vix_band";
const BAND_RANK = { LOW: 0, TRANSITIONING: 1, HIGH: 2, ALREADY_BREACHED: 3 };
const BAND_SHORT = { ...DD_VIX_BAND_LABELS, ALREADY_BREACHED: "S&P 10%+ below its high" };

async function atomFeed(request, ctx) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  let xml = null;
  try {
    const cache = caches.default;
    const hit = await cache.match(FEED_CACHE_KEY);
    if (hit) xml = await hit.text();
    else {
      // ~3 runs a weekday plus Saturday's; 140 rows covers FEED_DAYS + 1 weekdays.
      const rows = await supabase(`crash_checks?select=${FEED_FIELDS}&order=run_at.desc&limit=140`);
      xml = feedXml(rows);
      if (xml) ctx.waitUntil(cache.put(FEED_CACHE_KEY, new Response(xml, { headers: { "cache-control": `public, max-age=${CACHE_SECONDS}` } })));
    }
  } catch (e) { xml = null; }
  if (!xml) {
    return new Response("Feed temporarily unavailable.\n", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "300" } });
  }
  return new Response(request.method === "HEAD" ? null : xml, {
    headers: { "content-type": "application/atom+xml; charset=utf-8", "cache-control": `public, max-age=${CACHE_SECONDS}` },
  });
}

// rows: newest first. Returns null if there is nothing to publish.
function feedXml(rows) {
  const days = [];
  const seen = new Set();
  for (const row of rows) {
    const day = new Date(row.run_at).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (wd === 0 || wd === 6 || seen.has(day)) continue;
    seen.add(day);
    days.push({ day, row });
  }
  if (!days.length) return null;
  const entries = days.slice(0, FEED_DAYS).map((d, i) => feedEntry(d, days[i + 1] ?? null));
  return `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n`
    + `  <title>Market Stress Monitor: daily reading</title>\n`
    + `  <subtitle>Six US crash-risk indicators RED/AMBER/GREEN each weekday, from public data. Not investment advice.</subtitle>\n`
    + `  <id>tag:marketstress.org,2026:feed</id>\n`
    + `  <link rel="self" type="application/atom+xml" href="${SITE}/feed.xml"/>\n`
    + `  <link rel="alternate" type="text/html" href="${SITE}/"/>\n`
    + `  <updated>${new Date(days[0].row.run_at).toISOString()}</updated>\n`
    + `  <author><name>Market Stress Monitor</name><uri>${SITE}/</uri></author>\n`
    + `  <icon>${SITE}/icon-192.png</icon>\n`
    + entries.join("")
    + `</feed>\n`;
}

function bandKey(row) {
  const { status, band } = ddVixReading(row);
  return status === "ALREADY_BREACHED" ? "ALREADY_BREACHED" : band;
}

// Title, e.g. "Nov 25, 2026: 0 of 6 confirmed RED · drawdown risk High", with
// "▲ … (was …)" on the part that changed since the previous weekday.
function feedTitle(row, prev) {
  const n = row.confirmed_red_count ?? 0;
  const pn = prev ? prev.confirmed_red_count ?? 0 : n;
  const arrow = (up) => (up ? "▲ " : "▼ ");
  const pending = Math.max(0, (row.red_count ?? 0) - n);
  const parts = [`${n !== pn ? arrow(n > pn) : ""}${n} of 6 confirmed RED${n !== pn ? ` (was ${pn})` : ""}${pending ? ` +${pending} pending` : ""}`];
  const b = bandKey(row);
  const pb = prev ? bandKey(prev) : b;
  if (b) {
    const changed = pb && pb !== b;
    const label = b === "ALREADY_BREACHED" ? BAND_SHORT[b] : `drawdown risk ${BAND_SHORT[b] ?? b}`;
    parts.push(`${changed ? arrow(BAND_RANK[b] > BAND_RANK[pb]) : ""}${label}${changed ? ` (was ${BAND_SHORT[pb] ?? pb})` : ""}`);
  }
  return `${fmtDate(row.run_at, false)}: ${parts.join(" · ")}`;
}

function feedEntry({ day, row }, prevDay) {
  const { status, band } = ddVixReading(row);
  const bandText = status === "ALREADY_BREACHED"
    ? "Drawdown risk band: not scored, because the S&P 500 is already more than 10% below its high."
    : band
      ? `Drawdown risk band: ${DD_VIX_BAND_LABELS[band] ?? band}. Historically, ${DD_VIX_HIT_RATE[band] ?? "an unknown share"} of days in this band were followed by a 10%+ S&P 500 drawdown within about 21 trading days, against 12% on a typical day.`
      : "";
  const html = [
    `<p>${escHtml(summarySentence({ row, full: null }).replace(/^Latest reading/, "Reading"))}</p>`,
    bandText ? `<p>${escHtml(bandText)}</p>` : "",
    `<p>As of ${escHtml(fmtDate(row.run_at, true))}. Full reading: <a href="${SITE}/">${SITE.replace("https://", "")}</a></p>`,
    `<p><small>${escHtml(DISCLAIMER)}</small></p>`,
  ].join("");
  return `  <entry>\n`
    + `    <title>${escHtml(feedTitle(row, prevDay?.row ?? null))}</title>\n`
    + `    <id>tag:marketstress.org,${day}:reading</id>\n`
    + `    <link rel="alternate" type="text/html" href="${SITE}/"/>\n`
    + `    <updated>${new Date(row.run_at).toISOString()}</updated>\n`
    + `    <content type="html">${escHtml(html)}</content>\n`
    + `  </entry>\n`;
}

// The page's JSON-LD. Home: the Dataset's dateModified is set to the latest
// run. Tab pages (SEO audit 2026-11-25): the Dataset and the home WebPage are
// swapped for the tab's own CollectionPage with a breadcrumb, "about" the
// home Dataset, so the Dataset is described on one URL only. Leaves the
// script untouched if it doesn't parse.
function jsonLdRewrite(iso, page, path) {
  let buf = "";
  return {
    text(t) {
      buf += t.text;
      if (!t.lastInTextNode) { t.remove(); return; }
      let out = buf;
      try {
        const j = JSON.parse(buf);
        const graph = j["@graph"] ?? [];
        const modified = iso ? new Date(iso).toISOString() : null;
        if (page) {
          const url = `${SITE}${path}`;
          j["@graph"] = graph.filter((n) => n["@type"] !== "Dataset" && n["@type"] !== "WebPage").concat({
            "@type": "CollectionPage",
            "@id": `${url}#page`,
            url,
            name: page.title,
            description: page.description,
            isPartOf: { "@id": `${SITE}/#site` },
            about: { "@id": `${SITE}/#dataset` },
            ...(modified && page.tab !== "analysts" ? { dateModified: modified } : {}),
            breadcrumb: {
              "@type": "BreadcrumbList",
              itemListElement: [
                { "@type": "ListItem", position: 1, name: "Market Stress Monitor", item: `${SITE}/` },
                { "@type": "ListItem", position: 2, name: page.crumb, item: url },
              ],
            },
          });
        } else {
          const ds = graph.find((n) => n["@type"] === "Dataset");
          if (!ds || !modified) { t.replace(out, { html: true }); return; }
          ds.dateModified = modified;
        }
        // "</" can't appear inside a script element.
        out = `
${JSON.stringify(j, null, 2).replace(/<\//g, "<\\/")}
`;
      } catch (e) { out = buf; }
      t.replace(out, { html: true });
    },
  };
}

// Search results cut descriptions at about 155 characters (SEO audit
// 2026-11-25), so each one is the head plus as many optional tail parts as fit.
const DESCRIPTION_MAX = 155;
function fitDescription(head, tails) {
  let out = head;
  for (const t of tails) if (`${out} ${t}`.length <= DESCRIPTION_MAX) out = `${out} ${t}`;
  return out;
}

// The band as a short phrase, e.g. "drawdown risk band High (44% of past
// cases)"; null when it can't be scored or computed.
function bandPhrase(row) {
  const { status, band } = ddVixReading(row);
  if (status === "ALREADY_BREACHED") return "drawdown risk band not scored (S&P 500 already 10%+ off its high)";
  if (!band) return null;
  return `drawdown risk band ${DD_VIX_BAND_LABELS[band] ?? band} (${DD_VIX_HIT_RATE[band] ?? "?"} of past cases)`;
}

// e.g. "Nov 24, 2026: 0 of 6 US crash-risk indicators confirmed RED; drawdown
// risk band High (44% of past cases). Daily, from public data. Not investment advice."
function liveDescription(data) {
  const f = facts(data);
  const band = bandPhrase(data.row);
  return fitDescription(`${fmtDate(f.asOf, false)}: ${f.confirmed} of 6 US crash-risk indicators confirmed RED${band ? `; ${band}` : ""}.`,
    ["Daily, from public data.", "Not investment advice."]);
}

// The direct answer that opens the footer summary (#site-summary), ~60 words:
// "As of Nov 25, 2026, 0 of 6 US crash-risk indicators are confirmed RED, so
// the stress gate (3 of 6) is not met. The drawdown risk band is High: …"
function answerSentence(data) {
  const f = facts(data);
  const parts = [`As of ${fmtDate(f.asOf, false)}, ${f.confirmed} of 6 US crash-risk indicators ${f.confirmed === 1 ? "is" : "are"} confirmed RED, so the stress gate (3 of 6) is ${f.gateMet ? "met" : "not met"}.`];
  const { status, band } = ddVixReading(data.row);
  if (status === "ALREADY_BREACHED") parts.push("The drawdown risk band is not scored, because the S&P 500 is already more than 10% below its high.");
  else if (band) parts.push(`The drawdown risk band is ${DD_VIX_BAND_LABELS[band] ?? band}: historically, ${DD_VIX_HIT_RATE[band] ?? "an unknown share"} of days in this band were followed by a 10%+ S&P 500 drawdown within about a month, against 12% on a typical day.`);
  return parts.join(" ");
}

// ---- Data -----------------------------------------------------------------

async function loadLatest(ctx) {
  const cache = caches.default;
  const hit = await cache.match(CACHE_KEY);
  if (hit) return hit.json();
  const since = new Date(Date.now() - CONTEXT_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  // Margin debt: 430 days (month-start dates), since its growth needs the same month a year
  // earlier. The rest: 90 days covers ten put/call days and the latest COT week.
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const [latest, full, context, macro, smartRecent, smartMargin] = await Promise.all([
    supabase(`crash_checks?select=${LATEST_FIELDS}&order=run_at.desc&limit=1`),
    supabase("crash_checks?select=run_at,notes,scenario_method,scenario_prior_state,scenario_tilt,scenario_bear_pct,scenario_crash_pct&notes=not.is.null&order=run_at.desc&limit=1"),
    // Context is optional: a failure here must not take down the reading.
    supabase(`data_points?select=series_id,observation_date,value&series_id=in.(${CONTEXT_SERIES.join(",")})&observation_date=gte.${since}&order=observation_date.desc`).catch(() => []),
    // Macro & Fiscal narrative (index.html loadMacroNarrative): optional too,
    // and absent before its migration.
    supabase("crash_checks?select=run_at,macro_narrative&macro_narrative=not.is.null&order=run_at.desc&limit=1").catch(() => []),
    // Smart Money raw readings (optional, like context): ~120 small rows.
    supabase(`data_points?select=series_id,observation_date,value&series_id=in.(${SMART_SERIES.join(",")})&observation_date=gte.${daysAgo(90)}&order=observation_date.desc`).catch(() => []),
    supabase(`data_points?select=series_id,observation_date,value&series_id=eq.${SMART_MARGIN}&observation_date=gte.${daysAgo(430)}&order=observation_date.desc`).catch(() => []),
  ]);
  if (!latest[0]) return null;
  // Rows come newest first: the first per series is the latest, the last the oldest in the window.
  const ctxLatest = {}, ctxOldest = {};
  for (const r of context) { if (!(r.series_id in ctxLatest)) ctxLatest[r.series_id] = r; ctxOldest[r.series_id] = r; }
  let smart = null;
  try { smart = smartFacts([...smartRecent, ...smartMargin]); } catch (e) { smart = null; }
  const data = { row: latest[0], full: full[0] ?? null, context: ctxLatest, contextOldest: ctxOldest, macro: macro[0] ?? null, smart };
  ctx.waitUntil(cache.put(CACHE_KEY, new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_SECONDS}` },
  })));
  return data;
}

async function supabase(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
  return res.json();
}

// ---- Context beyond the gate ---------------------------------------------

// Financial-plumbing context shown on the page's Macro & Fiscal tab (no
// traffic light, not in the gate). Listed here so AI tools reading
// /latest.md see that the site covers more than the six gate indicators.
// Signal wording mirrors CONTEXT_INFO in index.html; change them together.
const CONTEXT_SERIES = ["OFR_FSI", "STLFSI4", "NFCI", "SOFR", "IORB", "DTWEXBGS", "T5YIFR", "T10YIE", "THREEFYTP10", "WALCL", "MOVE", "JGB10", "BUND10", "DEXJPUS", "DGS10", "COT_JY_LEV_FUNDS_NET_PCT_OI", "BAMLH0A3HYC", "BAMLH0A1HYBB"];
const CONTEXT_LOOKBACK_DAYS = 45;

// Inflation expectations, term premium, the Fed balance sheet and the OFR
// index (Macro & Fiscal tab), shared by /latest.md and the /macro description.
// The 5y5y here is FRED's Treasury/TIPS measure, never presented as the ICE
// swap rate people also search for.
function macroFacts(data) {
  const c = data.context ?? {}, o = data.contextOldest ?? {};
  const pick = (id) => (c[id] ? { v: Number(c[id].value), d: c[id].observation_date } : null);
  const f = { fwd: pick("T5YIFR"), be: pick("T10YIE"), tp: pick("THREEFYTP10"), ofr: pick("OFR_FSI"), bs: null };
  const bs = pick("WALCL"); // millions of dollars
  if (bs) {
    const then = o.WALCL && o.WALCL.observation_date !== bs.d ? o.WALCL : null;
    let trend = null;
    if (then) {
      const bn = Math.round((bs.v - Number(then.value)) / 1000);
      const weeks = Math.round((Date.parse(bs.d) - Date.parse(then.observation_date)) / (7 * 86400000));
      trend = bn === 0 ? `flat over ${weeks} weeks` : `${bn < 0 ? "down" : "up"} ${Math.abs(bn)} billion dollars over ${weeks} weeks (${bn < 0 ? "quantitative tightening" : "expanding"})`;
    }
    f.bs = { d: bs.d, text: `${(bs.v / 1e6).toFixed(2)} trillion dollars`, trend };
  }
  return f;
}

// Short form of the above for the /macro meta description (<= 155 chars):
// the date, the two most-searched numbers, then what else the tab has.
function macroDescription(data) {
  const m = macroFacts(data);
  const nums = [
    m.fwd && `5y5y inflation expectation ${m.fwd.v.toFixed(2)}%`,
    m.tp && `10-year term premium ${m.tp.v.toFixed(2)}%`,
    m.ofr && `OFR stress index ${m.ofr.v.toFixed(2)}`,
  ].filter(Boolean);
  if (!nums.length) return null;
  const day = m.fwd?.d ?? m.tp?.d ?? m.ofr?.d;
  let head = `${fmtDate(`${day}T12:00:00Z`, false)}: ${nums[0]}`;
  for (const n of nums.slice(1)) if (`${head}, ${n}.`.length <= 110) head = `${head}, ${n}`;
  return fitDescription(`${head}.`, ["Fiscal dominance checklist and yield curve.", "Not advice."]);
}

function contextLines(ctx, oldest) {
  if (!ctx) return [];
  const v = (id) => ctx[id]?.value;
  const d = (id) => ctx[id]?.observation_date;
  const above = (x, hi, lo) => (x > 0 ? hi : lo);
  const out = [];
  if (v("OFR_FSI") != null) out.push(`| OFR Financial Stress Index (US Treasury; credit, funding, volatility, valuation, US and abroad) | ${v("OFR_FSI").toFixed(2)} | ${above(v("OFR_FSI"), "above-average stress", "below-average stress")} (0 = average) | ${d("OFR_FSI")} |`);
  if (v("BAMLH0A3HYC") != null && v("BAMLH0A1HYBB") != null) out.push(`| Junk-bond quality gap: CCC & lower minus BB spread (ICE BofA) | ${(v("BAMLH0A3HYC") - v("BAMLH0A1HYBB")).toFixed(1)} pts | CCC ${v("BAMLH0A3HYC").toFixed(1)}% vs BB ${v("BAMLH0A1HYBB").toFixed(1)}%; the weakest borrowers' extra cost | ${d("BAMLH0A3HYC")} |`);
  if (v("STLFSI4") != null) out.push(`| St. Louis Fed Financial Stress Index | ${v("STLFSI4").toFixed(2)} | ${above(v("STLFSI4"), "above-average stress", "below-average stress")} (0 = average) | ${d("STLFSI4")} |`);
  if (v("NFCI") != null) out.push(`| Chicago Fed National Financial Conditions Index | ${v("NFCI").toFixed(2)} | ${above(v("NFCI"), "tighter than average", "looser than average")} (0 = average) | ${d("NFCI")} |`);
  if (v("SOFR") != null) {
    const gap = v("IORB") != null ? Math.round((v("SOFR") - v("IORB")) * 100) : null;
    out.push(`| SOFR overnight repo rate | ${v("SOFR").toFixed(2)}% | ${gap == null ? "repo-market funding cost" : `${gap >= 0 ? "+" : ""}${gap} bp vs the Fed's interest on reserves (${v("IORB").toFixed(2)}%); a sustained gap above it signals a cash squeeze`} | ${d("SOFR")} |`);
  }
  if (v("DTWEXBGS") != null) out.push(`| Broad trade-weighted US dollar index | ${v("DTWEXBGS").toFixed(2)} | a fast rise tightens conditions for foreign dollar borrowers | ${d("DTWEXBGS")} |`);
  // Global bonds (2026-11-25; Macro tab card, context only, no tested edge).
  if (v("MOVE") != null) out.push(`| MOVE index (ICE BofA, Treasury implied volatility: the bond market's VIX) | ${v("MOVE").toFixed(0)} | ${v("MOVE") > 160 ? "stress level (above 160)" : v("MOVE") > 130 ? "elevated (above 130)" : "normal (130 or below)"} | ${d("MOVE")} |`);
  if (v("JGB10") != null) out.push(`| Japan 10-year government bond yield (Ministry of Finance) | ${v("JGB10").toFixed(2)}% | Japan is the largest foreign holder of US Treasuries | ${d("JGB10")} |`);
  if (v("BUND10") != null) out.push(`| Germany 10-year government bond yield (Bundesbank) | ${v("BUND10").toFixed(2)}% | ${v("DGS10") != null ? `US 10-year minus Germany: ${(v("DGS10") - v("BUND10")).toFixed(2)} points` : "the euro area's benchmark"} | ${d("BUND10")} |`);
  if (v("COT_JY_LEV_FUNDS_NET_PCT_OI") != null) out.push(`| Hedge funds' net yen futures position (CFTC, % of open interest; negative = short yen) | ${v("COT_JY_LEV_FUNDS_NET_PCT_OI").toFixed(1)}% | ${v("COT_JY_LEV_FUNDS_NET_PCT_OI") <= -25 ? "carry trade crowded (-25% or lower)" : "carry trade not crowded"} | ${d("COT_JY_LEV_FUNDS_NET_PCT_OI")} |`);
  if (v("DEXJPUS") != null) out.push(`| Dollar/yen (Federal Reserve H.10) | ${v("DEXJPUS").toFixed(2)} | a fast fall (stronger yen) squeezes yen-funded carry trades | ${d("DEXJPUS")} |`);
  const m = macroFacts({ context: ctx, contextOldest: oldest });
  if (m.fwd) out.push(`| 5-year, 5-year forward inflation expectation (FRED T5YIFR, from Treasury and TIPS yields; not a swap rate) | ${m.fwd.v.toFixed(2)}% | average inflation the bond market expects for the five years starting five years from now | ${m.fwd.d} |`);
  if (m.be) out.push(`| 10-year breakeven inflation (FRED T10YIE) | ${m.be.v.toFixed(2)}% | inflation the bond market expects over the next 10 years | ${m.be.d} |`);
  if (m.tp) out.push(`| 10-year term premium (Kim-Wright model, FRED THREEFYTP10) | ${m.tp.v.toFixed(2)}% | extra yield investors demand for holding long bonds | ${m.tp.d} |`);
  if (m.bs) out.push(`| Fed balance sheet (H.4.1, FRED WALCL) | ${m.bs.text} | ${m.bs.trend ?? "everything the Fed owns"} | ${m.bs.d} |`);
  if (!out.length) return [];
  return [
    "",
    "## Context beyond the gate",
    "",
    "Shown on the page's Macro & Fiscal tab with no traffic light; they don't count toward the stress gate. The tab also has the fiscal-dominance checklist, the yield curve, Fed balance-sheet liquidity, credit-card delinquencies and breadth; the Smart Money tab has positioning percentiles (CFTC, CBOE put/call, FINRA margin debt) and 13F net buying.",
    "",
    "| Indicator | Value | Reading | Data date |",
    "|---|---|---|---|",
    ...out,
  ];
}

// ---- Shared facts ---------------------------------------------------------

const SCENARIO_PRIOR_FALL10 = { LOW: 8, TRANSITIONING: 8, HIGH: 19, ALREADY_BREACHED: 21 };

function facts({ row, full }) {
  const confirmed = row.confirmed_red_count ?? 0;
  const pending = Math.max(0, (row.red_count ?? 0) - confirmed);
  const indicators = INDICATORS.map((g) => {
    const value = row[g.v];
    const conf = g.conf ? row.confirmation_state?.[g.conf] : null;
    return {
      name: g.name,
      short: g.short,
      value: value == null ? "n/a" : (typeof value === "number" || g.conf === null ? g.fmt(value) : String(value)),
      color: row[g.c] ?? "n/a",
      pending: row[g.c] === "RED" && conf ? conf.confirmed === false : false,
      observed: conf?.observation_date ?? null,
    };
  });
  // LLM 3-month view: only tilt-based reports (2026-11-17 on); older splits had no defined horizon.
  const llm = full?.scenario_method === "tilt_v1" ? full : null;
  return { confirmed, pending, gateMet: !!row.wave_authorized, indicators, llm, asOf: row.run_at };
}

function fmtDate(iso, withTime) {
  const opts = { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" };
  if (withTime) Object.assign(opts, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return new Date(iso).toLocaleString("en-US", opts);
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- HTML -----------------------------------------------------------------

// Mirrors renderStressVerdict() in index.html (without its popovers), which
// replaces it once the page's JavaScript runs. Includes the drawdown risk
// band, so crawlers and AI tools see it (SEO audit 2026-11-25).
function verdictHtml(data) {
  const f = facts(data);
  const row = data.row;
  const gate = f.gateMet ? '<b class="bad">Stress gate met</b>' : '<b class="ok">Stress gate not met</b>';
  const { status, band } = ddVixReading(row);
  const hazard = status === "ALREADY_BREACHED" ? "Not scored <small>past 10%</small>"
    : band ? `<span class="dot bc-${escHtml(band)}" style="background:var(--bc)"></span>${escHtml(DD_VIX_BAND_LABELS[band] ?? band)} <small>${escHtml(DD_VIX_HIT_RATE[band] ?? "")} of past cases</small>` : "Unavailable";
  const w = row.warsh_classification;
  const regime = w ? `${escHtml(w.charAt(0) + w.slice(1).toLowerCase())} <small>${row.warsh_hard_rules_active ? "hard rules on" : "hard rules off"}</small>` : "—";
  return `<div class="headline"><div class="big">${f.confirmed}<em>/6</em> red</div>`
    + `<div class="sub">${gate} · gate needs 3 of 6 confirmed${f.pending ? ` · <b class="warn">${f.pending} pending</b>` : ""}</div></div>`
    + `<div class="facts"><div class="fact"><span class="lbl">Drawdown risk · 10% off peak, next month</span><span class="v">${hazard}</span></div>`
    + `<div class="fact"><span class="lbl">Fed regime</span><span class="v">${regime}</span></div></div>`
    + `<div class="stamp"><b>As of ${escHtml(fmtDate(f.asOf, true))}</b></div>`;
}

// "Readings: AMBER: VIX 26.62, high-yield spread 376 bp. GREEN: …." (the
// footer's list, after the answer sentence).
function readingLists(f) {
  const parts = [];
  for (const color of ["RED", "AMBER", "GREEN"]) {
    const list = f.indicators.filter((i) => i.color === color)
      .map((i) => `${i.short} ${i.value}${i.pending ? " (pending confirmation)" : ""}`);
    if (list.length) parts.push(`${color}: ${list.join(", ")}.`);
  }
  return parts.length ? `Readings: ${parts.join(" ")}` : "";
}

// One plain sentence for the feed, e.g. "Latest reading (Nov 15, 2026):
// 0 of 6 confirmed RED, stress gate not met. RED: 10-year Treasury yield
// 5.10% (pending confirmation). GREEN: VIX 19.30, high-yield spread …"
function summarySentence(data) {
  const f = facts(data);
  const lists = readingLists(f).replace(/^Readings: /, "");
  return `Latest reading (${fmtDate(f.asOf, false)}): ${f.confirmed} of 6 confirmed RED, stress gate ${f.gateMet ? "met" : "not met"}.${lists ? ` ${lists}` : ""}`;
}

// ---- Smart Money / Macro text for crawlers --------------------------------

// What the Smart Money tab measures, in words (its numbers load in the
// browser). Mirrors POSITIONING_MEASURES and the i-pos / i-rot popovers in
// index.html; change them together.
const SMART_INTRO_HTML = `<div class="headline"><div class="big">Where the money is leaning</div>
<div class="sub">Positioning and flows · weeks to quarters</div></div>
<div class="nar">
<p><b>Market positioning.</b> How crowded are the main bets? Seven measures, each ranked as a percentile of its own history (5 years for futures and put/call, since 1998 for margin debt): asset managers' and hedge funds' S&amp;P 500 futures, hedge funds' VIX, 10-year Treasury and yen futures (the yen carry trade) from the CFTC Commitments of Traders report, the CBOE equity put/call ratio, and FINRA margin debt. A crowded bet is fragile, so extremes are read contrarian: heavy fear has often come near bottoms, heavy greed near tops. Context only: not a timing signal (not backtested), and never part of the 3-of-6 stress gate.</p>
<p><b>Sector capital rotation.</b> Is money actually moving into the sectors that are rising? Each Select Sector SPDR fund's price return against its estimated flow (the daily change in shares outstanding times price) as a share of its size, over 5 days to a year, with SPY and gold as benchmarks. Price up with money arriving is a confirmed move; a rally while money leaves is not backed by new buyers.</p>
<p><b>Institutional 13F net buying.</b> Which sectors' stocks big institutions bought more of last quarter than the average sector, from every 13F filer's holdings, counted in shares so price moves don't count. Quarterly and 45+ days late: it shows what institutions backed last quarter, not what is happening now.</p>
<p>Sources: CFTC, CBOE, FINRA, SEC EDGAR, fund share data. Public data; not investment advice.</p>
</div>`;

// Latest raw Smart Money readings for crawlers (SEO audit 2026-11-25: the
// tab had no numbers in its HTML). Raw values only: the percentiles need
// years of history and load in the browser. Series, labels and the put/call
// 10-day average / margin growth formulas mirror POSITIONING_MEASURES and
// positioningDerivedSeries in index.html; change them together.
const SMART_COT = [
  ["COT_ES_ASSET_MGR_NET_PCT_OI", "Asset managers, S&P 500 futures"],
  ["COT_ES_LEV_FUNDS_NET_PCT_OI", "Hedge funds, S&P 500 futures"],
  ["COT_VIX_LEV_FUNDS_NET_PCT_OI", "Hedge funds, VIX futures"],
  ["COT_TY_LEV_FUNDS_NET_PCT_OI", "Leveraged funds, 10-year Treasury futures"],
  ["COT_JY_LEV_FUNDS_NET_PCT_OI", "Hedge funds, yen futures"],
];
const SMART_PUT_CALL = "CBOE_EQUITY_PC_RATIO";
const SMART_MARGIN = "FINRA_MARGIN_DEBIT_USD_MILLIONS";
const SMART_SERIES = [...SMART_COT.map(([id]) => id), SMART_PUT_CALL];

// rows: any order. Returns null when nothing loaded.
function smartFacts(rows) {
  const by = {};
  for (const r of rows) (by[r.series_id] ??= []).push({ d: r.observation_date, v: Number(r.value) });
  for (const k of Object.keys(by)) by[k].sort((a, b) => (a.d < b.d ? 1 : -1)); // newest first
  const cot = SMART_COT.filter(([id]) => by[id]?.length).map(([id, label]) => ({ label, v: by[id][0].v, d: by[id][0].d }));
  const pc = by[SMART_PUT_CALL] ?? [];
  const putCall = pc.length >= 10 ? { v: pc.slice(0, 10).reduce((a, p) => a + p.v, 0) / 10, d: pc[0].d } : null;
  const mg = by[SMART_MARGIN] ?? [];
  let margin = null;
  if (mg.length) {
    const now = mg[0];
    const prior = mg.find((p) => p.d.slice(0, 7) === `${Number(now.d.slice(0, 4)) - 1}${now.d.slice(4, 7)}`);
    margin = { usdT: now.v / 1e6, yoy: prior ? ((now.v - prior.v) / prior.v) * 100 : null, d: now.d };
  }
  if (!cot.length && !putCall && !margin) return null;
  return { cot, putCall, margin };
}

const fmtDay = (d) => fmtDate(`${d}T12:00:00Z`, false);
const fmtMonthYear = (d) => new Date(`${d.slice(0, 7)}-01T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const signedPct = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}%`;

function smartVerdictHtml(s) {
  const fact = (lbl, v, small) => `<div class="fact context"><span class="lbl">${escHtml(lbl)}</span><span class="v">${escHtml(v)}${small ? ` <small>${escHtml(small)}</small>` : ""}</span></div>`;
  const facts = [
    s.putCall && fact("Equity put/call", s.putCall.v.toFixed(2), `10-day avg · ${s.putCall.d}`),
    s.margin && fact("Margin debt", `$${s.margin.usdT.toFixed(2)}T`, `${s.margin.yoy != null ? `${signedPct(s.margin.yoy)} vs a year ago · ` : ""}${fmtMonthYear(s.margin.d)}`),
  ].filter(Boolean).join("");
  const cotDay = s.cot.map((c) => c.d).sort().at(-1);
  const cot = s.cot.length
    ? `<p><b>Futures positioning</b> (CFTC Commitments of Traders, net position as a share of open interest, week of ${escHtml(fmtDay(cotDay))}): ${s.cot.map((c) => `${escHtml(c.label)} ${escHtml(signedPct(c.v))}`).join("; ")}.</p>`
    : "";
  // The intro's paragraphs, without its headline (this one has its own).
  const intro = SMART_INTRO_HTML.slice(SMART_INTRO_HTML.indexOf('<div class="nar">') + '<div class="nar">'.length);
  return `<div class="headline"><div class="big">Where the money is leaning</div><div class="sub">Positioning and flows · weeks to quarters</div></div>`
    + `<div class="facts">${facts}</div><div class="nar">${cot}<p>Latest raw readings; where each sits in its own history (the percentiles) loads with the page.</p>${intro}`;
}

// e.g. "Nov 24, 2026: equity put/call 0.62 (10-day), margin debt +18.0% vs a
// year ago. CFTC positioning percentiles and 13F net buying by sector. …"
function smartDescription(s) {
  const nums = [
    s.putCall && `equity put/call ${s.putCall.v.toFixed(2)} (10-day)`,
    s.margin?.yoy != null && `margin debt ${signedPct(s.margin.yoy)} vs a year ago`,
  ].filter(Boolean);
  if (!nums.length) return null;
  const day = s.putCall?.d ?? s.margin.d;
  return fitDescription(`${fmtDay(day)}: ${nums.join(", ")}.`, ["CFTC positioning percentiles and 13F net buying by sector.", "Not investment advice."]);
}

const MACRO_INTRO_HTML = `<div class="headline"><div class="big">Macro &amp; Fiscal</div>
<div class="sub">The slower US backdrop · quarters to years</div></div>
<div class="nar"><p>A real-data fiscal dominance checklist (Taylor rule gap, primary balance, net interest, auctions, inflation expectations with term premium), the Treasury yield curve, and financial-stress and funding indicators: OFR Financial Stress Index, St. Louis Fed FSI, Chicago Fed NFCI, SOFR against interest on reserves, the Fed balance sheet and the dollar. Public data; not investment advice.</p></div>`;

// The Macro tab's headline with today's numbers and the latest AI-written
// summary ("What it adds up to"), for crawlers; replaced by renderMacroVerdict().
function macroVerdictHtml(data) {
  const m = macroFacts(data);
  const fact = (lbl, v, small) => `<div class="fact context"><span class="lbl">${escHtml(lbl)}</span><span class="v">${escHtml(v)}${small ? ` <small>${escHtml(small)}</small>` : ""}</span></div>`;
  const facts = [
    m.fwd && fact("5y5y inflation expectation", `${m.fwd.v.toFixed(2)}%`, `Treasury/TIPS · ${m.fwd.d}`),
    m.be && fact("10Y breakeven", `${m.be.v.toFixed(2)}%`, m.be.d),
    m.tp && fact("10Y term premium", `${m.tp.v.toFixed(2)}%`, `Kim-Wright · ${m.tp.d}`),
    m.bs && fact("Fed balance sheet", m.bs.text, m.bs.trend ?? m.bs.d),
    m.ofr && fact("OFR stress index", m.ofr.v.toFixed(2), `${m.ofr.v > 0 ? "above" : "below"} average · ${m.ofr.d}`),
  ].filter(Boolean).join("");
  const text = data.macro?.macro_narrative ? String(data.macro.macro_narrative).replace(/\r\n/g, "\n").trim() : "";
  const nar = text
    ? `<div class="nar"><p><b>What it adds up to</b> (AI-written, ${escHtml(fmtDate(data.macro.run_at, false))})</p>${text.split(/\n\s*\n/).map((p) => `<p>${escHtml(p.trim())}</p>`).join("")}</div>`
    : "";
  if (!facts && !nar) return MACRO_INTRO_HTML;
  return `<div class="headline"><div class="big">Macro &amp; Fiscal</div><div class="sub">The slower US backdrop · quarters to years</div></div>`
    + `<div class="facts">${facts}</div>${nar}`;
}

// ---- Notable Views --------------------------------------------------------

// The views themselves, grouped by topic, as plain HTML for /views. Uses the
// same classes as renderAnalystViews() in index.html, which replaces it with
// the live data comparison once the page's JavaScript runs.
function viewsDescription(content) {
  const names = (content.analysts ?? []).map((a) => a.name).filter(Boolean);
  if (!names.length) return null;
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  const text = `Public views of ${who} on debt, rates, the Fed and markets, each linked, dated and checked against live data.`;
  return text.length <= DESCRIPTION_MAX ? text : null;
}

function viewsHtml(content) {
  const fmt = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "");
  const all = (content.analysts ?? []).flatMap((a) => (a.themes ?? []).map((t) => ({ a, t })));
  const topics = (content.topics ?? []).map((topic) => ({ topic, items: all.filter((e) => e.t.topic === topic.id) })).filter((x) => x.items.length);
  if (!topics.length) return null;
  const view = ({ a, t }) => `<div class="vw" data-person="${escHtml(a.id)}"><span class="av">${escHtml(a.initials ?? "")}</span>`
    + `<span class="who"><b>${escHtml(a.name)}</b><span>${escHtml(a.role ?? "")}</span></span>`
    + `<span class="q">${escHtml(t.view)}${t.source?.url ? `<span class="src"><a href="${escHtml(t.source.url)}" target="_blank" rel="noopener">${escHtml(t.source.title ?? "Source")} ↗</a> · ${escHtml(fmt(t.source.date))}</span>` : ""}</span>`
    + `<span class="side"></span></div>`;
  const body = topics.map(({ topic, items }) => `<div class="nvtopic" id="nv-t-${escHtml(topic.id)}"><h3>${escHtml(topic.title)}<small>${escHtml(topic.question ?? "")} · ${items.length} view${items.length === 1 ? "" : "s"}</small></h3>`
    + `<div class="nvgroup">${items.map(view).join("")}</div></div>`).join("");
  return `<section class="rsec"><div class="sh"><span class="lbl">Notable Views</span><span class="note">Reviewed ${escHtml(fmt(content.last_reviewed))}</span></div>`
    + `<p class="nar">Public views of well-known macro investors and economists, grouped by topic. Each is a short paraphrase (quotes word for word), linked and dated, and checked against this site's live data in the browser. A comparison of frameworks, not a verdict on who's right. Not affiliated with or endorsed by anyone named. Not investment advice.</p></section>`
    + `<section class="rsec" id="nv-detail">${body}</section>`;
}

// ---- Markdown -------------------------------------------------------------

function markdown(data) {
  const f = facts(data);
  const row = data.row;
  const lines = [
    "# Market Stress Monitor: latest reading",
    "",
    `As of ${fmtDate(f.asOf, true)}. Live page: ${SITE}/`,
    "",
    // Same schedule as STRESS_SCHEDULE in index.html; change them together.
    "Updates: data refresh around 10am ET (Mon-Sat) and 6pm ET (weekdays); daily written report around 6:30pm ET (weekdays). Times are approximate.",
    "",
    `**${f.confirmed} of 6 core indicators confirmed RED. Stress gate (3 of 6 confirmed) ${f.gateMet ? "met" : "not met"}.**${f.pending ? ` ${f.pending} RED reading${f.pending > 1 ? "s" : ""} pending confirmation.` : ""}`,
    "",
    "| Indicator | Value | Status | Data date |",
    "|---|---|---|---|",
    ...f.indicators.map((i) => `| ${i.name} | ${i.value} | ${i.color}${i.pending ? " (pending confirmation)" : ""} | ${i.observed ?? "AI judgment over Fed rate data"} |`),
    "",
  ];
  const { status: bandStatus, band } = ddVixReading(row);
  if (bandStatus === "ALREADY_BREACHED") {
    lines.push("- Drawdown risk band: not scored (the S&P 500 is already more than 10% below its high).");
  } else if (band) {
    lines.push(`- Drawdown risk band (could a 10%+ S&P 500 drawdown begin within 21 trading days; from S&P drawdown and VIX): ${DD_VIX_BAND_LABELS[band] ?? band}. Historically, ${DD_VIX_HIT_RATE[band] ?? "an unknown share"} of days in this band were followed by such a drawdown, against 12% on a typical day.`);
  }
  if (row.warsh_classification) lines.push(`- Fed policy regime: ${row.warsh_classification.charAt(0)}${row.warsh_classification.slice(1).toLowerCase()}.`);
  if (f.llm) {
    // SCENARIO_PRIOR_FALL10: bear + crash of config/scenario_prior_v1.json "prior"; copied in index.html too.
    const hist = SCENARIO_PRIOR_FALL10[f.llm.scenario_prior_state];
    const tilt = { lower: "lower risk than", in_line: "in line with", higher: "higher risk than" }[f.llm.scenario_tilt] ?? f.llm.scenario_tilt;
    lines.push(`- AI view, next 3 months (${fmtDate(f.llm.run_at, false)}): ${tilt} history for this risk band. Chance of a 10%+ S&P 500 fall within 63 trading days: ${f.llm.scenario_bear_pct + f.llm.scenario_crash_pct}%${hist != null ? `, against ${hist}% for such days since 1990` : ""}. An AI judgment limited to one 5-point step from that history.`);
  }
  lines.push(...contextLines(data.context, data.contextOldest));
  if (data.macro?.macro_narrative) {
    lines.push("", `## Macro & Fiscal: what it adds up to (AI-written, ${fmtDate(data.macro.run_at, false)})`, "", String(data.macro.macro_narrative).replace(/\r\n/g, "\n").trim());
  }
  const notes = data.full?.notes ? String(data.full.notes).replace(RUN_LABEL, "").trim() : "";
  if (notes) {
    // Same note as index.html's fromReportNote: the narrative comes from the
    // last full report, so its figures can predate the table above.
    const older = Date.parse(data.full.run_at) < Date.parse(f.asOf);
    lines.push("", `## Narrative (${fmtDate(data.full.run_at, false)})`, "",
      ...(older ? [`From the ${fmtDate(data.full.run_at, true)} full report; its figures predate the newer readings above.`, ""] : []),
      notes.replace(/\r\n/g, "\n"));
  }
  lines.push("", "---", "", DISCLAIMER, "", `Cite as: Market Stress Monitor, ${SITE}/, reading of ${fmtDate(f.asOf, false)}.`, "");
  return lines.join("\n");
}
