#!/usr/bin/env node
// Leak guard: blocks a push whose new commits contain personal data.
//
// The sensitive lists are read at run time from the gitignored local_state/
// folder (policy private terms, watchlist tickers, fund names and dollar
// figures from portfolio.yaml, plus local_state/leak-guard.yaml), so the lists
// themselves never enter the repo. Generic secret patterns (tokens, private
// keys, service-role JWTs) and forbidden paths are checked too.
//
// Install once per clone:   git config core.hooksPath .githooks
// Manual runs:              node .githooks/leak-guard.mjs --all
//                           node .githooks/leak-guard.mjs --range origin/main..HEAD
// Bypass (false positive):  add the term to allow_terms in local_state/leak-guard.yaml,
//                           or put "leak-guard: allow" on the line, or as a last
//                           resort `git push --no-verify`.
//
// Exit code 0 = clean, 1 = blocked (or the guard couldn't run: fails closed).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const git = (args, opts = {}) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30, ...opts });

const top = git(["rev-parse", "--show-toplevel"]).trim();
const stateDir = process.env.LEAK_GUARD_STATE_DIR || path.join(top, "local_state");

function fail(msg) {
  console.error(`\nleak-guard: ${msg}\n`);
  process.exit(1);
}

// --- YAML loader: reuse js-yaml from whichever package has it installed ---
function loadYamlLib() {
  for (const pkg of ["rule_engine", "mcp_server", "ingestion"]) {
    const pj = path.join(top, pkg, "package.json");
    if (!existsSync(pj)) continue;
    try {
      return createRequire(pj)("js-yaml");
    } catch {}
  }
  fail("js-yaml not found. Run `npm ci` in rule_engine/ (or mcp_server/) first.");
}
const yaml = loadYamlLib();
const readYaml = (name) => {
  const p = path.join(stateDir, name);
  return existsSync(p) ? yaml.load(readFileSync(p, "utf8")) : undefined;
};

// --- Build the sensitive lists from local files ---
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const config = readYaml("leak-guard.yaml") || {};
const allow = new Set((config.allow_terms || []).map((s) => String(s).toLowerCase()));
const rules = []; // { kind, label, re }

function addTerm(kind, term, { caseSensitive = false } = {}) {
  term = String(term ?? "").trim();
  if (term.length < 2 || allow.has(term.toLowerCase())) return;
  const re = new RegExp(`(?<![A-Za-z0-9])${escape(term)}(?![A-Za-z0-9])`, caseSensitive ? "g" : "gi");
  rules.push({ kind, label: term, re });
}

const policy = readYaml("policy.yaml");
const watchlist = readYaml("watchlist.yaml");
const portfolio = readYaml("portfolio.yaml");
if (!policy && !watchlist && !portfolio && !process.env.LEAK_GUARD_ALLOW_EMPTY) {
  fail(`no local_state files found in ${stateDir}; refusing to run blind ` +
    "(set LEAK_GUARD_STATE_DIR, or LEAK_GUARD_ALLOW_EMPTY=1 to check secrets only).");
}

for (const t of policy?.private_terms || []) addTerm("private term", t);
for (const t of config.extra_terms || []) addTerm("identity/extra term", t);
for (const t of watchlist?.tickers || []) {
  const sym = typeof t === "string" ? t : t?.symbol ?? t?.ticker;
  if (sym) addTerm("watchlist ticker", sym, { caseSensitive: true });
}

// Fund keys (holding identifiers) and fund labels from portfolio.yaml.
const GENERIC_KEY = /(usd|cad|pct|rate|ratio|value|_at|date|through|days|months|count)$/i;
(function walkFunds(o) {
  if (Array.isArray(o)) return o.forEach(walkFunds);
  if (!o || typeof o !== "object") return;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "number" && k.includes("_") && !GENERIC_KEY.test(k)) addTerm("fund name", k);
    walkFunds(v);
  }
})(portfolio?.accounts);
for (const [k, v] of Object.entries(portfolio?.fund_labels || {})) {
  addTerm("fund name", k);
  if (typeof v === "string") addTerm("fund name", v);
}

// Numbers: dollar-sized values and precise decimals (allocation %, rates).
const numbers = new Set();
const collectNumbers = (o) => {
  if (Array.isArray(o)) return o.forEach(collectNumbers);
  if (o && typeof o === "object") return Object.values(o).forEach(collectNumbers);
  if (typeof o === "number" && Number.isFinite(o)) numbers.add(o);
};
for (const doc of [portfolio, watchlist, policy, readYaml("wave_deployment_state.yaml"), readYaml("exchange_log.yaml")]) collectNumbers(doc);
for (const n of numbers) {
  const abs = Math.abs(n);
  if (Number.isInteger(abs)) {
    // Small ints, years and round numbers (1,000 / 3,000 / 250,000) are too
    // generic: they collide with timeouts, limits and examples in code.
    if (abs < 1000 || (abs >= 1900 && abs <= 2100)) continue;
    if (abs % 1000 === 0 || (abs < 10000 && abs % 100 === 0)) continue;
    const plain = String(abs), comma = abs.toLocaleString("en-US");
    const forms = [...new Set([plain, comma])].map(escape).join("|");
    rules.push({ kind: "dollar figure", label: comma, re: new RegExp(`(?<![\\d.,])(?:${forms})(?![\\d]|[.,]\\d)`, "g") });
    if (abs >= 10000) {
      const k = Math.round(abs / 1000);
      rules.push({ kind: "dollar figure", label: `$${k}k`, re: new RegExp(`\\$${k}(?:\\.\\d)?\\s?[kK]\\b`, "g") });
    }
  } else {
    // Values under 1 (expense ratios, FX rates, fractions) are public or generic.
    if (abs < 1) continue;
    const s = String(abs);
    const decimals = s.split(".")[1]?.length ?? 0;
    // Two or more decimals is specific enough on its own; one decimal needs a
    // % sign. Never match inside a longer number or a version string (8.36.0).
    const tail = decimals >= 2 ? "(?![\\d]|\\.\\d)" : "\\s?%";
    rules.push({ kind: "allocation/rate figure", label: s, re: new RegExp(`(?<![\\d.])${escape(s)}${tail}`, "g") });
  }
}

// Generic secret patterns (no local data needed).
const SECRET_RULES = [
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{10,}/g],
  ["API key (sk-)", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];
for (const [label, re] of SECRET_RULES) rules.push({ kind: "secret", label, re });
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{5,}/g;
const ASSIGNED_SECRET = /\b(SUPABASE_SERVICE_ROLE_KEY|[A-Z_]*(?:API_KEY|SECRET|TOKEN|PASSWORD))\s*[:=]\s*["']?([A-Za-z0-9_\-./+=]{16,})/g;

const FORBIDDEN_PATH = [
  [/^local_state\/(?!.*\.example\.yaml$|\.gitkeep$)/, "real local_state file"],
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, ".env file"],
  [/\.(pem|key)$/i, "key file"],
  [/^review_bundle\//, "review bundle"],
];
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|pdf|mp4|mov|webm)$/i;
const GENERATED = /(^|\/)package-lock\.json$/; // machine-written; version numbers only

// --- Which commits to scan ---
function revListArgs() {
  const argv = process.argv.slice(2);
  if (argv.includes("--all")) return [["--all"]];
  const r = argv.indexOf("--range");
  if (r >= 0) return [[argv[r + 1]]];
  // pre-push: args = <remote name> <url>; stdin = "<lref> <lsha> <rref> <rsha>" per line.
  const remote = argv[0] && !argv[0].startsWith("-") ? argv[0] : "origin";
  let stdin = "";
  try { stdin = readFileSync(0, "utf8"); } catch {}
  const sets = [];
  for (const line of stdin.split("\n")) {
    const [, lsha, , rsha] = line.trim().split(/\s+/);
    if (!lsha || /^0+$/.test(lsha)) continue; // branch deletion
    if (rsha && !/^0+$/.test(rsha)) {
      try { git(["cat-file", "-e", `${rsha}^{commit}`]); sets.push([`${rsha}..${lsha}`]); continue; } catch {}
    }
    sets.push([lsha, "--not", `--remotes=${remote}`]);
  }
  return sets;
}

// --- Scan ---
const findings = [];
const images = new Set();
const mask = (s) => (s.length <= 3 ? s[0] + "**" : s.slice(0, 2) + "…" + s.slice(-1));
const ALLOW_LINE = /leak-guard:\s*allow/;

function checkText(text, where) {
  if (ALLOW_LINE.test(text)) return;
  for (const r of rules) {
    r.re.lastIndex = 0;
    const m = r.re.exec(text);
    if (m) findings.push({ where, kind: r.kind, label: r.kind === "secret" ? r.label : mask(r.label) });
  }
  JWT.lastIndex = 0;
  let j;
  while ((j = JWT.exec(text))) {
    let role = "?";
    try { role = JSON.parse(Buffer.from(j[1], "base64url").toString()).role ?? "?"; } catch {}
    if (role !== "anon") findings.push({ where, kind: "secret", label: `JWT (role: ${role})` });
  }
  ASSIGNED_SECRET.lastIndex = 0;
  let a;
  while ((a = ASSIGNED_SECRET.exec(text))) {
    if (!/^(your|example|xxx|changeme|placeholder|<)/i.test(a[2])) findings.push({ where, kind: "secret", label: `${a[1]} value` });
  }
}

const SEP = "\x1e";
let scanned = 0;
for (const args of revListArgs()) {
  const commits = git(["rev-list", ...args]).split("\n").filter(Boolean);
  for (const sha of commits) {
    scanned++;
    const short = sha.slice(0, 7);
    const meta = git(["show", "-s", `--format=%an${SEP}%ae${SEP}%cn${SEP}%ce${SEP}%B`, sha]);
    const [an, ae, cn, ce, body] = meta.split(SEP);
    checkText(`${an} ${ae} ${cn} ${ce}`, `${short} author/committer`);
    body.split("\n").forEach((l, i) => checkText(l, `${short} commit message line ${i + 1}`));

    const diff = git(["show", "--format=", "-U0", "--no-color", "--no-ext-diff", "--first-parent", "-m", "--src-prefix=a/", "--dst-prefix=b/", sha]);
    let file = "", lineNo = 0;
    for (const l of diff.split("\n")) {
      if (l.startsWith("diff --git ")) { file = l.split(" b/").pop(); continue; }
      if (l.startsWith("+++ ")) {
        file = l === "+++ /dev/null" ? file : l.slice(6);
        for (const [re, why] of FORBIDDEN_PATH) if (re.test(file)) findings.push({ where: `${short} ${file}`, kind: "forbidden path", label: why });
        checkText(file, `${short} file name ${file}`);
        continue;
      }
      if (l.startsWith("Binary files ")) { if (IMAGE.test(file)) images.add(`${short} ${file}`); continue; }
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
      if (h) { lineNo = Number(h[1]); continue; }
      if (l.startsWith("+")) {
        if (!GENERATED.test(file)) checkText(l.slice(1), `${short} ${file}:${lineNo}`);
        lineNo++;
      }
    }
  }
}

// --- Report ---
const imagesOk = process.env.LEAK_GUARD_IMAGES_OK === "1";
if (!findings.length && (imagesOk || !images.size)) {
  console.error(`leak-guard: ${scanned} commit(s) checked against ${rules.length} rules, clean.`);
  process.exit(0);
}
const seen = new Set();
const lines = findings.filter((f) => { const k = `${f.where}|${f.kind}|${f.label}`; if (seen.has(k)) return false; seen.add(k); return true; });
if (lines.length) {
  const byKind = {};
  for (const f of lines) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  console.error(`\nleak-guard: BLOCKED. ${lines.length} finding(s) in ${scanned} commit(s): ` +
    Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ") + "\n");
  for (const f of lines.slice(0, 60)) console.error(`  ${f.where}  [${f.kind}: ${f.label}]`);
  if (lines.length > 60) console.error(`  ... and ${lines.length - 60} more`);
}
if (images.size && !imagesOk) {
  console.error(`\nleak-guard: ${images.size} new or changed image/binary file(s). Check them by eye for personal data,`);
  console.error(`then push again with LEAK_GUARD_IMAGES_OK=1:`);
  for (const i of [...images].slice(0, 20)) console.error(`  ${i}`);
}
console.error(`\nFix the commit (git commit --amend / rebase), or if a hit is a false positive, add it to`);
console.error(`allow_terms in local_state/leak-guard.yaml or mark the line "leak-guard: allow".\n`);
process.exit(1);
