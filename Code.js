// Polymarket tail-hedge scanner for Google Sheets (Apps Script)
// Goal:
//  - Surface ONE-SIDED outcomes (not whole markets) that are cheap (low ask)
//  - AND compute per-market overround (sum of best asks across outcomes minus 1)
//  - Exclude sports markets
//
// Data sources:
// - Gamma markets: https://gamma-api.polymarket.com/markets
// - CLOB prices:  https://clob.polymarket.com/prices
//
// Notes:
// - We do NOT require complete outcome coverage; we keep any outcome with a price.
// - Overround is computed on AVAILABLE asks; we also report coverage.
//   * coverage = (#outcomes with ask) / (total #outcomes)
//   * overround_partial = sum(asks_available) - 1

const GAMMA_BASE = "https://gamma-api.polymarket.com";
const CLOB_BASE  = "https://clob.polymarket.com";

// ---- PARAMETERS (tune) ----
const MAX_PAGES = 60;            // upper bound; scan stops earlier if time limit hit
const PAGE_SIZE = 200;
const MIN_VOLUME = 0;            // set e.g. 1000 to avoid dead markets
const MIN_ASK = 0.01;            // ignore dust outcomes (e.g. 0.001)
const MAX_ASK = 0.25;            // keep outcomes with ask <= this (e.g. 0.25)
const MIN_COVERAGE = 0.50;       // only compute/use overround if >= this coverage (0..1)
const SLEEP_MS = 150;            // raise if rate-limited
const MAX_ROWS_OUTPUT = 5000;
const MAX_SECONDS = 320;         // hard stop to avoid Apps Script timeout
const ANNUALIZATION_DAYS = 365;  // for rate-style normalization

// Optional: simple topic tags (does NOT filter; it just labels rows)
const TOPIC_TAGS = [
  { tag: "gold",     re: /gold|xau|gc|xauusd|comex/ },
  { tag: "btc",      re: /bitcoin|btc/ },
  { tag: "oil",      re: /oil|wti|brent/ },
  { tag: "rates",    re: /yield|rates|fed|10y|2y|treasury/ },
  { tag: "election", re: /election|president|trump|biden|vote/ },
  { tag: "war",      re: /war|invasion|nuclear|missile|iran|russia|china|taiwan/ }
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("Polymarket")
    .addItem("Scan tail outcomes (+ overround)", "scanTailOutcomes")
    .addItem("Clear results", "clearTailScan")
    .addToUi();
}

function clearTailScan() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName("tail_scan");
  if (sh) sh.clearContents();
}

function scanTailOutcomes() {
  const t0 = Date.now();
  const timedOut = () => ((Date.now() - t0) / 1000) > MAX_SECONDS;

  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName("tail_scan") || ss.insertSheet("tail_scan");
  sh.clearContents();

  const header = [
    "rank",
    "ask",
    "overround_partial (sum_asks-1)",
    "coverage",
    "sum_asks_available",
    "days_to_resolution",
    "overround_per_year",
    "market_volume",
    "num_outcomes",
    "market_id",
    "slug",
    "topic_tags",
    "outcome",
    "question"
  ];
  sh.getRange(1, 1, 1, header.length).setValues([header]);

  // 1) Discover markets (non-sports)
  const markets = [];  // each market will also carry endDate (if available)
  let offset = 0;

  for (let p = 0; p < MAX_PAGES; p++) {
    if (timedOut()) break;

    const gamma = gammaGetMarkets(PAGE_SIZE, offset);
    if (gamma.error) {
      sh.getRange(2, 1).setValue(gamma.error);
      return;
    }

    const page = gamma.markets;
    if (!page || page.length === 0) break;

    for (let i = 0; i < page.length; i++) {
      const m = page[i];
      if (isSportsMarket(m)) continue;

      const outcomes = normalizeToArray(m.outcomes);
      const tokens = normalizeToArray(m.clobTokenIds || m.clobTokenIDs);
      if (!outcomes || !tokens) continue;
      if (outcomes.length < 2) continue;
      if (tokens.length !== outcomes.length) continue;

      const vol = parseFloat(m.volume || m.volumeNum || m.volumeUSD || 0);
      if (vol < MIN_VOLUME) continue;

      markets.push({
        market_id: String(m.id),
        slug: String(m.slug || ""),
        question: String(m.question || ""),
        volume: vol,
        endDate: m.endDate ? new Date(m.endDate) : (m.closeTime ? new Date(m.closeTime) : null),
        outcomes: outcomes.map(String),
        tokens: tokens.map(String)
      });
    }

    offset += PAGE_SIZE;
    Utilities.sleep(SLEEP_MS);
  }

  if (markets.length === 0) {
    sh.getRange(2, 1).setValue("No non-sports markets found in scanned pages.");
    return;
  }

  // 2) Fetch asks per token (best executable ask)
  const tokenIds = dedupeTokens(markets.flatMap(m => m.tokens));
  const asks = {};

  // NOTE: /prices payload is 2x tokenIds (BUY+SELL). Keep chunks modest.
  const CHUNK = 80;
  for (let i = 0; i < tokenIds.length; i += CHUNK) {
    if (timedOut()) break;
    const chunk = tokenIds.slice(i, i + CHUNK);
    const part = clobGetAsksFromPrices(chunk);
    for (const k in part) asks[k] = part[k];
    Utilities.sleep(SLEEP_MS);
  }

  // 3) Compute per-market sum_asks / coverage / overround (partial)
  const marketStats = {}; // market_id -> {sumAsks, covered, total, coverage, overround}

  for (let mi = 0; mi < markets.length; mi++) {
    if (timedOut()) break;
    const m = markets[mi];

    let sumAsks = 0;
    let covered = 0;
    const total = m.tokens.length;

    for (let oi = 0; oi < total; oi++) {
      const a = asks[m.tokens[oi]];
      if (a == null) continue;
      sumAsks += a;
      covered += 1;
    }

    const coverage = total > 0 ? (covered / total) : 0;
    const overround = (coverage > 0) ? (sumAsks - 1.0) : null;

    let daysToResolution = null;
    if (m.endDate instanceof Date && !isNaN(m.endDate)) {
      const ms = m.endDate.getTime() - Date.now();
      if (ms > 0) daysToResolution = ms / (1000 * 60 * 60 * 24);
    }

    let overroundPerDay = null;
    let overroundAnnualized = null;
    if (overround != null && daysToResolution && daysToResolution > 0) {
      overroundPerDay = overround / daysToResolution;
      overroundAnnualized = overroundPerDay * ANNUALIZATION_DAYS;
    }

    marketStats[m.market_id] = {
      sumAsks,
      covered,
      total,
      coverage,
      overround,
      daysToResolution: null,
      overroundPerDay: null,
      overroundAnnualized: null
    };
  }

  // 4) Emit one row per cheap outcome, now with market overround columns
  const rows = [];
  for (let mi = 0; mi < markets.length; mi++) {
    if (timedOut()) break;
    const m = markets[mi];

    const stats = marketStats[m.market_id] || { sumAsks: 0, coverage: 0, overround: null, total: m.tokens.length, covered: 0 };
    const coverage = stats.coverage || 0;

    // Option: skip markets where we barely have prices
    if (coverage < MIN_COVERAGE) continue;

    const topicTags = tagTopics(m.question + " " + m.slug);

    for (let oi = 0; oi < m.tokens.length; oi++) {
      const tid = m.tokens[oi];
      const ask = asks[tid];
      if (ask == null) continue;
      if (ask < MIN_ASK) continue;
      if (ask > MAX_ASK) continue;

            const daysTo = daysToResolution(m);
      const overPerYear = (stats.overround == null || daysTo == null || daysTo <= 0)
        ? null
        : (stats.overround / (daysTo / 365.0));

      rows.push({
        ask,
        overround: stats.overround,
        coverage: coverage,
        sumAsks: stats.sumAsks,
        days_to: daysTo,
        over_per_year: overPerYear,
        volume: m.volume,
        num_outcomes: m.tokens.length,
        market_id: m.market_id,
        slug: m.slug,
        topic_tags: topicTags,
        outcome: m.outcomes[oi] || "",
        question: m.question
      });
    }
  }

  if (rows.length === 0) {
    const msg = timedOut()
      ? `Timed out (~${MAX_SECONDS}s). Try raising MAX_SECONDS, raising MAX_ASK, lowering MIN_COVERAGE, or increasing MIN_VOLUME.`
      : `No outcomes found with ask in [${MIN_ASK}, ${MAX_ASK}] and coverage>=${MIN_COVERAGE}. Try raising MAX_ASK or lowering MIN_COVERAGE.`;
    sh.getRange(2, 1).setValue(msg);
    return;
  }

  // Sort: cheapest ask first, then tighter overround (lower), then more liquid
  // Sort: cheap tails first, then highest time-normalized overround
  rows.sort((a, b) =>
    (a.ask - b.ask) ||
    ((b.overroundAnnualized ?? -999) - (a.overroundAnnualized ?? -999)) ||
    (b.volume - a.volume)
  );

    const out = rows.slice(0, MAX_ROWS_OUTPUT).map((r, idx) => ([
    idx + 1,
    r.ask,
    r.overround,
    r.coverage,
    r.sumAsks,
    r.days_to,
    r.over_per_year,
    r.volume,
    r.num_outcomes,
    r.market_id,
    r.slug,
    r.topic_tags,
    r.outcome,
    r.question
  ]));

  sh.getRange(2, 1, out.length, header.length).setValues(out);

    // Formatting
  sh.getRange(2, 2, out.length, 1).setNumberFormat("0.000");  // ask
  sh.getRange(2, 3, out.length, 1).setNumberFormat("0.0000"); // overround
  sh.getRange(2, 4, out.length, 1).setNumberFormat("0.0% ");   // coverage
  sh.getRange(2, 5, out.length, 1).setNumberFormat("0.000");  // sum asks
  sh.getRange(2, 6, out.length, 1).setNumberFormat("0");      // days to resolution
  sh.getRange(2, 7, out.length, 1).setNumberFormat("0.00");   // overround per year
  sh.getRange(2, 8, out.length, 1).setNumberFormat("0");      // volume

  sh.autoResizeColumns(1, header.length);
}

// ===== Helpers =====

function normalizeToArray(x) {
  if (x == null) return null;
  if (Array.isArray(x)) return x;
  if (typeof x === "string") {
    const s = x.trim();
    if (!s) return null;
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [s];
    } catch (_) {
      return [s];
    }
  }
  return null;
}

function dedupeTokens(arr) {
  const seen = {};
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const t = arr[i];
    if (!t) continue;
    if (!seen[t]) {
      seen[t] = true;
      out.push(String(t));
    }
  }
  return out;
}

function gammaGetMarkets(limit, offset) {
  const url = `${GAMMA_BASE}/markets?closed=false&limit=${limit}&offset=${offset}`;
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const code = r.getResponseCode();
  const text = r.getContentText();

  if (code !== 200) {
    return { markets: [], error: `Gamma HTTP ${code}` };
  }

  try {
    return { markets: JSON.parse(text), error: null };
  } catch (e) {
    return { markets: [], error: "Gamma parse error" };
  }
}

function clobGetAsksFromPrices(tokenIds) {
  const url = `${CLOB_BASE}/prices`;
  const payload = [];

  for (let i = 0; i < tokenIds.length; i++) {
    const t = String(tokenIds[i]);
    payload.push({ token_id: t, side: "BUY" });
    payload.push({ token_id: t, side: "SELL" });
  }

  const r = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (r.getResponseCode() !== 200) return {};

  let data;
  try {
    data = JSON.parse(r.getContentText());
  } catch (e) {
    return {};
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) return {};

  // data[tokenId] = { BUY?: "0.34", SELL?: "0.36" }
  // Define ask as max(BUY, SELL) to avoid side semantics ambiguity.
  const out = {};
  for (const tid in data) {
    const row = data[tid];
    if (!row) continue;

    const pBuy = row.BUY != null ? parseFloat(row.BUY) : NaN;
    const pSell = row.SELL != null ? parseFloat(row.SELL) : NaN;

    let ask = null;
    if (!Number.isNaN(pBuy) && !Number.isNaN(pSell)) ask = Math.max(pBuy, pSell);
    else if (!Number.isNaN(pBuy)) ask = pBuy;
    else if (!Number.isNaN(pSell)) ask = pSell;

    if (ask != null) out[String(tid)] = ask;
  }

  return out;
}

function daysToResolution(marketObj) {
  // Try common Gamma fields; fall back to null.
  const now = new Date();

  const candidates = [
    marketObj.endDate,
    marketObj.end_date,
    marketObj.closeTime,
    marketObj.close_time,
    marketObj.resolutionTime,
    marketObj.resolution_time
  ];

  for (let i = 0; i < candidates.length; i++) {
    const v = candidates[i];
    if (!v) continue;
    const d = parseDate(v);
    if (!d) continue;
    const ms = d.getTime() - now.getTime();
    const days = ms / (1000 * 60 * 60 * 24);
    if (isFinite(days)) return days;
  }

  return null;
}

function parseDate(v) {
  // Gamma typically uses ISO strings; sometimes numeric seconds/ms.
  if (v == null) return null;
  if (typeof v === "number") {
    // heuristics: seconds vs ms
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function tagTopics(text) {
  const t = String(text || "").toLowerCase();
  const hits = [];
  for (let i = 0; i < TOPIC_TAGS.length; i++) {
    if (TOPIC_TAGS[i].re.test(t)) hits.push(TOPIC_TAGS[i].tag);
  }
  return hits.length ? hits.join(",") : "";
}

function isSportsMarket(m) {
  const cat = String(m.category || "").toLowerCase();
  const tags = Array.isArray(m.tags) ? m.tags.join(" ").toLowerCase() : String(m.tags || "").toLowerCase();
  const q = String(m.question || "").toLowerCase();
  const s = String(m.slug || "").toLowerCase();

  if (cat.includes("sports") || tags.includes("sports")) return true;

  const re = /nfl|nba|wnba|nhl|mlb|ncaa|ufc|formula 1|f1|motogp|premier league|la liga|serie a|bundesliga|ligue 1|mls|uefa|fifa|champions? league|europa league|conference league|fa cup|copa|stanley cup|super bowl|halftime|mvp|rookie|playoffs?|season|match|game/;
  if (re.test(q)) return true;

  if (/(nfl|nba|wnba|nhl|mlb|ncaa|ufc|f1|formula-1|motogp|premier-league|la-liga|serie-a|bundesliga|ligue-1|mls|uefa|fifa|champions|europa|conference|fa-cup|copa|stanley-cup|super-bowl)/.test(s)) return true;

  if (q.includes(" vs ") && (q.includes("win") || q.includes("beat") || q.includes("match") || q.includes("game"))) return true;

  return false;
}
