/**
 * Zakat app — Egyptian gold price relay (Cloudflare Worker, free tier)
 *
 * What it does
 *  - Reads the live Egyptian gold table from TWO independent public pages.
 *  - Rejects readings that don't make sense (wrong 21K/24K ratio, impossible
 *    USD/EGP, stale page) and cross-checks the two sources against each other.
 *  - Caches the result in KV so 10,000 app users cost the source sites
 *    only ~1 request per 5 minutes.
 *  - Serves JSON with CORS so the browser app can read it.
 *
 * Setup: see the short steps in the chat. You need one KV namespace bound
 * to this Worker under the variable name  PRICES.
 */

const SOURCES = [
  { name: 'gold-price-live',  url: 'https://gold-price-live.com/',          parse: parseGoldPriceLive  },
  { name: 'gold-price-daily', url: 'https://gold-price-daily.com/gold-eg/', parse: parseGoldPriceDaily }
];

const REFRESH_AFTER_SEC = 300;   // scrape at most once per 5 minutes
const MAX_SOURCE_GAP    = 0.015; // the two sources must agree within 1.5%
const OUNCE_GRAMS       = 31.1035;

export default {
  // Browser requests
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders() });
    try {
      const data = await getPrices(env);
      if (!data) return json({ ok: false, error: 'no_source_available' }, 503);
      return json(data, 200, { 'Cache-Control': 'public, max-age=60' });
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 500);
    }
  },
  // Optional cron trigger (every 5 min) keeps the cache warm
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env));
  }
};

/* ---------- cache layer ---------- */

async function getPrices(env) {
  const saved = await env.PRICES.get('prices', 'json');
  const ageSec = saved ? (Date.now() - saved.fetchedAt) / 1000 : Infinity;
  if (saved && ageSec < REFRESH_AFTER_SEC) return { ...saved, ageSec: Math.round(ageSec) };

  const fresh = await refresh(env);
  if (fresh) return { ...fresh, ageSec: 0 };

  // Every source failed: serve the last good reading, clearly marked stale.
  if (saved) return { ...saved, ageSec: Math.round(ageSec), stale: true };
  return null;
}

async function refresh(env) {
  const data = await buildPrices();
  if (data) await env.PRICES.put('prices', JSON.stringify(data));
  return data;
}

/* ---------- scrape + validate + agree ---------- */

async function buildPrices() {
  const raw = await Promise.all(SOURCES.map(async (s) => {
    try {
      const html = await fetchText(s.url);
      const r = s.parse(html);
      return r ? { name: s.name, ...r } : { name: s.name, error: 'parse_failed' };
    } catch (e) {
      return { name: s.name, error: String(e && e.message || e) };
    }
  }));
  return combine(raw);
}

// Pure function (easy to test): takes parsed readings, returns the final answer or null.
function combine(raw) {
  const usdRef = (raw.find(r => !r.error && r.usdBank) || {}).usdBank || null;
  const good = [];
  const report = [];

  for (const r of raw) {
    if (r.error) { report.push({ name: r.name, ok: false, why: r.error }); continue; }
    const why = insane(r, usdRef);
    if (why) { report.push({ name: r.name, ok: false, why }); continue; }
    good.push(r);
    report.push({ name: r.name, ok: true, k21: r.k21, k24: r.k24 });
  }
  if (!good.length) return null;

  let chosen, confidence, note = null;
  if (good.length === 1) {
    chosen = { k21: good[0].k21, k24: good[0].k24 };
    confidence = 'medium';
    note = 'single_source';
  } else {
    const [a, b] = good;
    const gap = Math.abs(a.k21 - b.k21) / ((a.k21 + b.k21) / 2);
    if (gap <= MAX_SOURCE_GAP) {
      chosen = { k21: round2((a.k21 + b.k21) / 2), k24: round2((a.k24 + b.k24) / 2) };
      confidence = 'high';
    } else {
      // Disagreement: trust the source whose implied USD/EGP is closest to the bank rate.
      const dist = (r) => (usdRef && r.ounceUsd) ? Math.abs(r.k24 / (r.ounceUsd / OUNCE_GRAMS) - usdRef) : Infinity;
      const pick = dist(a) <= dist(b) ? a : b;
      chosen = { k21: pick.k21, k24: pick.k24 };
      confidence = 'medium';
      note = 'sources_disagree';
    }
  }

  const ounce = (good.find(r => r.ounceUsd) || {}).ounceUsd || null;
  return {
    ok: true,
    fetchedAt: Date.now(),
    asOf: new Date().toISOString(),
    gold: { k21: chosen.k21, k24: chosen.k24 },   // EGP per gram, mid price
    usdBank: usdRef,
    ounceUsd: ounce,
    confidence,
    note,
    sources: report
  };
}

// Returns a reason string if the reading looks wrong, otherwise null.
function insane(r, usdRef) {
  if (!(r.k24 > 0) || !(r.k21 > 0)) return 'missing_karat';
  const ratio = r.k21 / r.k24;                       // should be 21/24 = 0.875
  if (ratio < 0.865 || ratio > 0.885) return 'bad_21_24_ratio';
  if (r.staleMinutes != null && r.staleMinutes > 120) return 'page_is_stale';
  if (usdRef && r.ounceUsd) {
    const implied = r.k24 / (r.ounceUsd / OUNCE_GRAMS);   // implied EGP per USD
    const rel = implied / usdRef;
    if (rel < 0.90 || rel > 1.12) return 'implied_usd_out_of_range';
  }
  return null;
}

/* ---------- source parsers (work on page TEXT, not CSS selectors, so they survive layout changes) ---------- */

const NUM = '([\\d][\\d,]*(?:\\.\\d+)?)';
const toNum = (s) => parseFloat(String(s).replace(/,/g, ''));
const round2 = (n) => Math.round(n * 100) / 100;

function toText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))   // Arabic-Indic digits -> 0-9
    .replace(/[|]/g, ' ')
    .replace(/\s+/g, ' ');
}

// Source A: table rows look like  "ذهب عيار 21  6165 جنيه مصري  6145 جنيه مصري"  (buy, sell)
function parseGoldPriceLive(html) {
  const t = toText(html);
  const row = (k) => {
    const m = t.match(new RegExp('ذهب\\s*عيار\\s*' + k + '\\s+' + NUM + '\\s*جنيه(?:\\s*مصري)?\\s+' + NUM + '\\s*جنيه'));
    return m ? round2((toNum(m[1]) + toNum(m[2])) / 2) : null;   // mid of buy/sell
  };
  const usd = t.match(/الدولار\s*في\s*البنوك\s+([\d][\d,]*(?:\.\d+)?)/);
  const oz  = t.match(new RegExp('أونصة\\s*الذهب\\s+' + NUM + '\\s*دولار'));
  const k21 = row('21'), k24 = row('24');
  if (!k21 || !k24) return null;
  return { k21, k24, usdBank: usd ? toNum(usd[1]) : null, ounceUsd: oz ? toNum(oz[1]) : null };
}

// Source B: rows look like  "غرام ذهب عيار 21  6155.36  116.57"  (EGP, USD)
function parseGoldPriceDaily(html) {
  const t = toText(html);
  const row = (k) => {
    const m = t.match(new RegExp('غرام\\s*ذهب\\s*عيار\\s*' + k + '\\s+' + NUM));
    return m ? toNum(m[1]) : null;
  };
  const oz  = t.match(new RegExp('أونصة\\s*ذهب\\s*عيار\\s*24\\s+' + NUM + '\\s+' + NUM));
  const age = t.match(/آخر\s*تحديث\s*قبل\s*(\d+)\s*دقيقة/);
  const k21 = row('21'), k24 = row('24');
  if (!k21 || !k24) return null;
  return {
    k21, k24,
    usdBank: null,
    ounceUsd: oz ? toNum(oz[2]) : null,           // second number = USD
    staleMinutes: age ? parseInt(age[1], 10) : null
  };
}

/* ---------- helpers ---------- */

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZakatApp/1.0)', 'Accept-Language': 'ar,en;q=0.8' },
    signal: AbortSignal.timeout(8000),
    cf: { cacheTtl: 60 }
  });
  if (!res.ok) throw new Error('http_' + res.status);
  return res.text();
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(), ...extra }
  });
}
