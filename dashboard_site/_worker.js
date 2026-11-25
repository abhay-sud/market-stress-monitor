// Cloudflare Pages "advanced mode" worker (2026-11-15).
//
// Why: the page loads its data in the browser, so search crawlers and AI
// tools that read HTML without running JavaScript only saw "Loading…".
// This worker puts the latest reading into the HTML they receive and serves
// the same reading as plain text at /latest.md. Browsers get the same page
// as before; the client-side render replaces the inserted headline.
//
// Scope: _routes.json sends only "/", the tab pages (TAB_PAGES), "/sitemap.xml" and
// "/latest.md" here; every other file
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
const CACHE_KEY = `${SITE}/__cache/latest-reading-v2`;
const FETCH_TIMEOUT_MS = 2000;

const LATEST_FIELDS = "run_at,vix_value,vix_color,hy_spread_bps,hy_spread_color,sp_drawdown_pct,sp_drawdown_color,treasury_10y_pct,treasury_10y_color,sahm_rule_value,sahm_rule_color,fed_pivot_signal,fed_pivot_color,red_count,confirmed_red_count,confirmation_state,wave_authorized,warsh_classification,dd_vix_band,crash_probability_pct";

// Same order, labels and formats as GATE_ROWS in index.html.
const INDICATORS = [
  { name: "VIX", short: "VIX", v: "vix_value", c: "vix_color", conf: "vix", fmt: (v) => v.toFixed(2) },
  { name: "High-yield credit spread", short: "high-yield spread", v: "hy_spread_bps", c: "hy_spread_color", conf: "hy_spread", fmt: (v) => `${Math.round(v)} bp` },
  { name: "S&P 500 drawdown from all-time high", short: "S&P 500 drawdown", v: "sp_drawdown_pct", c: "sp_drawdown_color", conf: "sp_drawdown", fmt: (v) => `${v.toFixed(2)}%` },
  { name: "10-year Treasury yield", short: "10-year Treasury yield", v: "treasury_10y_pct", c: "treasury_10y_color", conf: "treasury_10y", fmt: (v) => `${v.toFixed(2)}%` },
  { name: "Sahm rule", short: "Sahm rule", v: "sahm_rule_value", c: "sahm_rule_color", conf: "sahm_rule", fmt: (v) => v.toFixed(2) },
  { name: "Fed pivot signal", short: "Fed pivot signal", v: "fed_pivot_signal", c: "fed_pivot_color", conf: null, fmt: (v) => (v === "NONE" ? "none" : String(v).toLowerCase()) },
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
    brand: "· Smart Money",
    title: "Smart Money: market positioning and 13F flows · Market Stress Monitor",
    description: "Where the money is leaning: CFTC futures positioning, CBOE put/call and FINRA margin debt as historical percentiles, sector ETF capital rotation, and institutional 13F net buying by sector. Built from public data; not investment advice.",
  },
  "/macro": {
    tab: "macro",
    brand: "· Macro &amp; Fiscal",
    title: "Macro & Fiscal: fiscal dominance, yield curve, financial stress · Market Stress Monitor",
    description: "The slower US macro backdrop: a real-data fiscal dominance checklist, the Treasury yield curve with term premium, and financial-stress and funding indicators (OFR FSI, St. Louis Fed FSI, NFCI, SOFR, net liquidity). Built from public data; not investment advice.",
  },
  "/views": {
    tab: "analysts",
    brand: "· Notable Views",
    title: "Notable Views: macro investors' views vs live data · Market Stress Monitor",
    // Names are filled in from analyst_views.json (viewsDescription) when it loads.
    description: "Public views of well-known macro investors and economists on debt, rates, the Fed, inflation, recession and markets, each linked and dated and checked against live data.",
  },
};
const TAB_PANELS = ["stressmonitor", "smartmoney", "macro", "analysts"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/latest.md") return latestMarkdown(request, ctx);
    if (url.pathname === "/sitemap.xml") return sitemapXml(request, env, ctx);
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
        .on("#site-summary", { element(el) { el.append(` ${escHtml(summarySentence(data))}`, { html: true }); } })
        .on('script[type="application/ld+json"]', datasetDateModified(data.row.run_at));
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
    }
    return rw.transform(new Response(asset.body, { status: asset.status, headers }));
  },
};

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

// Sets the Dataset's dateModified in the page's JSON-LD to the latest run.
// Leaves the script untouched if it doesn't parse.
function datasetDateModified(iso) {
  let buf = "";
  return {
    text(t) {
      buf += t.text;
      if (!t.lastInTextNode) { t.remove(); return; }
      let out = buf;
      try {
        const j = JSON.parse(buf);
        const ds = (j["@graph"] ?? []).find((n) => n["@type"] === "Dataset");
        if (ds && iso) { ds.dateModified = new Date(iso).toISOString(); out = `\n${JSON.stringify(j, null, 2)}\n`; }
      } catch (e) { out = buf; }
      t.replace(out, { html: true });
    },
  };
}

// e.g. "Nov 24, 2026: 0 of 6 crash-risk indicators confirmed RED. VIX 26.62
// (amber), high-yield spread 376 bp (amber), … A daily read on US market
// crash risk from public data; not investment advice."
function liveDescription(data) {
  const f = facts(data);
  const list = f.indicators.map((i) => `${i.short} ${i.value} (${String(i.color).toLowerCase()}${i.pending ? ", pending" : ""})`).join(", ");
  return `${fmtDate(f.asOf, false)}: ${f.confirmed} of 6 crash-risk indicators confirmed RED. ${list.charAt(0).toUpperCase()}${list.slice(1)}. A daily read on US market crash risk from public data; not investment advice.`;
}

// ---- Data -----------------------------------------------------------------

async function loadLatest(ctx) {
  const cache = caches.default;
  const hit = await cache.match(CACHE_KEY);
  if (hit) return hit.json();
  const since = new Date(Date.now() - CONTEXT_LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const [latest, full, context, macro] = await Promise.all([
    supabase(`crash_checks?select=${LATEST_FIELDS}&order=run_at.desc&limit=1`),
    supabase("crash_checks?select=run_at,notes,scenario_method,scenario_prior_state,scenario_tilt,scenario_bear_pct,scenario_crash_pct&notes=not.is.null&order=run_at.desc&limit=1"),
    // Context is optional: a failure here must not take down the reading.
    supabase(`data_points?select=series_id,observation_date,value&series_id=in.(${CONTEXT_SERIES.join(",")})&observation_date=gte.${since}&order=observation_date.desc`).catch(() => []),
    // Macro & Fiscal narrative (index.html loadMacroNarrative): optional too,
    // and absent before its migration.
    supabase("crash_checks?select=run_at,macro_narrative&macro_narrative=not.is.null&order=run_at.desc&limit=1").catch(() => []),
  ]);
  if (!latest[0]) return null;
  // Rows come newest first: the first per series is the latest, the last the oldest in the window.
  const ctxLatest = {}, ctxOldest = {};
  for (const r of context) { if (!(r.series_id in ctxLatest)) ctxLatest[r.series_id] = r; ctxOldest[r.series_id] = r; }
  const data = { row: latest[0], full: full[0] ?? null, context: ctxLatest, contextOldest: ctxOldest, macro: macro[0] ?? null };
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
const CONTEXT_SERIES = ["OFR_FSI", "STLFSI4", "NFCI", "SOFR", "IORB", "DTWEXBGS", "T5YIFR", "T10YIE", "THREEFYTP10", "WALCL"];
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

// e.g. "Nov 24, 2026 macro backdrop: 5y5y forward inflation expectation 2.13%
// (from Treasury and TIPS yields), …". Null when none of the series loaded.
function macroDescription(data) {
  const m = macroFacts(data);
  const parts = [];
  if (m.fwd) parts.push(`5y5y forward inflation expectation ${m.fwd.v.toFixed(2)}% (from Treasury and TIPS yields)`);
  if (m.be) parts.push(`10-year breakeven ${m.be.v.toFixed(2)}%`);
  if (m.tp) parts.push(`10-year term premium ${m.tp.v.toFixed(2)}%`);
  if (m.bs) parts.push(`Fed balance sheet ${m.bs.text}${m.bs.trend ? `, ${m.bs.trend}` : ""}`);
  if (m.ofr) parts.push(`OFR Financial Stress Index ${m.ofr.v.toFixed(2)} (${m.ofr.v > 0 ? "above" : "below"} average)`);
  if (!parts.length) return null;
  const day = m.fwd?.d ?? m.be?.d ?? m.ofr?.d;
  return `${day ? `${fmtDate(`${day}T12:00:00Z`, false)} macro backdrop: ` : "Macro backdrop: "}${parts.join(", ")}. Plus a fiscal dominance checklist and the Treasury yield curve. Public data; not investment advice.`;
}

function contextLines(ctx, oldest) {
  if (!ctx) return [];
  const v = (id) => ctx[id]?.value;
  const d = (id) => ctx[id]?.observation_date;
  const above = (x, hi, lo) => (x > 0 ? hi : lo);
  const out = [];
  if (v("OFR_FSI") != null) out.push(`| OFR Financial Stress Index (US Treasury; credit, funding, volatility, valuation, US and abroad) | ${v("OFR_FSI").toFixed(2)} | ${above(v("OFR_FSI"), "above-average stress", "below-average stress")} (0 = average) | ${d("OFR_FSI")} |`);
  if (v("STLFSI4") != null) out.push(`| St. Louis Fed Financial Stress Index | ${v("STLFSI4").toFixed(2)} | ${above(v("STLFSI4"), "above-average stress", "below-average stress")} (0 = average) | ${d("STLFSI4")} |`);
  if (v("NFCI") != null) out.push(`| Chicago Fed National Financial Conditions Index | ${v("NFCI").toFixed(2)} | ${above(v("NFCI"), "tighter than average", "looser than average")} (0 = average) | ${d("NFCI")} |`);
  if (v("SOFR") != null) {
    const gap = v("IORB") != null ? Math.round((v("SOFR") - v("IORB")) * 100) : null;
    out.push(`| SOFR overnight repo rate | ${v("SOFR").toFixed(2)}% | ${gap == null ? "repo-market funding cost" : `${gap >= 0 ? "+" : ""}${gap} bp vs the Fed's interest on reserves (${v("IORB").toFixed(2)}%); a sustained gap above it signals a cash squeeze`} | ${d("SOFR")} |`);
  }
  if (v("DTWEXBGS") != null) out.push(`| Broad trade-weighted US dollar index | ${v("DTWEXBGS").toFixed(2)} | a fast rise tightens conditions for foreign dollar borrowers | ${d("DTWEXBGS")} |`);
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

// Mirrors the headline part of renderStressVerdict() in index.html, which
// replaces it once the page's JavaScript runs.
function verdictHtml(data) {
  const f = facts(data);
  const gate = f.gateMet ? '<b class="bad">Stress gate met</b>' : '<b class="ok">Stress gate not met</b>';
  return `<div class="headline"><div class="big">${f.confirmed}<em>/6</em> red</div>`
    + `<div class="sub">${gate} · gate needs 3 of 6 confirmed${f.pending ? ` · <b class="warn">${f.pending} pending</b>` : ""}</div></div>`
    + `<div class="facts"></div><div class="stamp"><b>As of ${escHtml(fmtDate(f.asOf, true))}</b></div>`;
}

// One plain sentence for the footer, e.g. "Latest reading (Nov 15, 2026):
// 0 of 6 confirmed RED, stress gate not met. RED: 10-year Treasury yield
// 5.10% (pending confirmation). GREEN: VIX 19.30, high-yield spread …"
function summarySentence(data) {
  const f = facts(data);
  const parts = [`Latest reading (${fmtDate(f.asOf, false)}): ${f.confirmed} of 6 confirmed RED, stress gate ${f.gateMet ? "met" : "not met"}.`];
  for (const color of ["RED", "AMBER", "GREEN"]) {
    const list = f.indicators.filter((i) => i.color === color)
      .map((i) => `${i.short} ${i.value}${i.pending ? " (pending confirmation)" : ""}`);
    if (list.length) parts.push(`${color}: ${list.join(", ")}.`);
  }
  return parts.join(" ");
}

// ---- Notable Views --------------------------------------------------------

// The views themselves, grouped by topic, as plain HTML for /views. Uses the
// same classes as renderAnalystViews() in index.html, which replaces it with
// the live data comparison once the page's JavaScript runs.
function viewsDescription(content) {
  const names = (content.analysts ?? []).map((a) => a.name).filter(Boolean);
  if (!names.length) return null;
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  return `Public views of ${who} on debt, rates, the Fed, inflation, recession and markets, each linked and dated and checked against live data.`;
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
    lines.push("", `## Narrative (${fmtDate(data.full.run_at, false)})`, "", notes.replace(/\r\n/g, "\n"));
  }
  lines.push("", "---", "", DISCLAIMER, "", `Cite as: Market Stress Monitor, ${SITE}/, reading of ${fmtDate(f.asOf, false)}.`, "");
  return lines.join("\n");
}
