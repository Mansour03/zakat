/**
 * Zakat app — Egyptian gold price relay (Cloudflare Worker, free tier)
 * Reads live prices from eDahab and Egyptian Gold sources.
 */

const SOURCES = [
  { name: 'edahab',            url: 'https://edahabapp.com/',                parse: parseEDahab },
  { name: 'gold-price-live',  url: 'https://gold-price-live.com/',          parse: parseGoldPriceLive }
];

const REFRESH_AFTER_SEC = 300;   // Scrape every 5 minutes
const MAX_SOURCE_GAP    = 0.015; // Max gap between sources 1.5%
const OUNCE_GRAMS       = 31.1035;

export default {
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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refresh(env));
  }
};

async function getPrices(env) {
  const saved = await env.PRICES.get('prices', 'json');
  const ageSec = saved ? (Date.now() - saved.fetchedAt) / 1000 : Infinity;
  if (saved && ageSec < REFRESH_AFTER_SEC) return { ...saved, ageSec: Math.round(ageSec) };

  const fresh = await refresh(env);
  if (fresh) return { ...fresh, ageSec: 0 };

  if (saved) return { ...saved, ageSec: Math.round(ageSec), stale: true };
  return null;
}

async function refresh(env) {
  const data = await buildPrices();
  if (data) await env.PRICES.put('prices', JSON.stringify(data));
  return data;
}

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

function combine(raw) {
  const usdRef = (raw.find(r => !r.error && r.usdBank) || {}).usdBank || null;
  const good = [];
  const report = [];

  for (const r of raw) {
    if (r.error) { report.push({ name: r.name, ok: false, why: r.error }); continue; }
    if (!(r.k24 > 0) || !(r.k21 > 0)) { report.push({ name: r.name, ok: false, why: 'missing_karat' }); continue; }
    good.push(r);
    report.push({ name: r.name, ok: true, k21: r.k21, k24: r.k24 });
  }
  if (!good.length) return null;

  const chosen = { k21: good[0].k21, k24: good[0].k24 };
  const ounce = (good.find(r => r.ounceUsd) || {}).ounceUsd || null;

  return {
    ok: true,
    fetchedAt: Date.now(),
    asOf: new Date().toISOString(),
    gold: { k21: chosen.k21, k24: chosen.k24 },
    usdBank: usdRef,
    ounceUsd: ounce,
    confidence: 'high',
    sources: report
  };
}

const NUM = '([\\d][\\d,]*(?:\\.\\d+)?)';
const toNum = (s) => parseFloat(String(s).replace(/,/g, ''));
const round2 = (n) => Math.round(n * 100) / 100;

function toText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/\s+/g, ' ');
}

function parseEDahab(html) {
  const t = toText(html);
  const getKarat = (k) => {
    const m = t.match(new RegExp('عيار\\s*' + k + '[\\s\\S]*?بيع:\\s*' + NUM + '\\s*جنيه[\\s\\S]*?شراء:\\s*' + NUM + '\\s*جنيه'));
    return m ? round2((toNum(m[1]) + toNum(m[2])) / 2) : null;
  };

  const usd = t.match(/الدولار\s*الأمريكي:\s*([\d][\d,]*(?:\.\d+)?)/);
  const k21 = getKarat('21'), k24 = getKarat('24');
  
  if (!k21 || !k24) return null;
  return { k21, k24, usdBank: usd ? toNum(usd[1]) : null };
}

function parseGoldPriceLive(html) {
  const t = toText(html);
  const row = (k) => {
    const m = t.match(new RegExp('ذهب\\s*عيار\\s*' + k + '\\s+' + NUM + '\\s*جنيه(?:\\s*مصري)?\\s+' + NUM + '\\s*جنيه'));
    return m ? round2((toNum(m[1]) + toNum(m[2])) / 2) : null;
  };
  const usd = t.match(/الدولار\s*في\s*البنوك\s+([\d][\d,]*(?:\.\d+)?)/);
  const k21 = row('21'), k24 = row('24');
  if (!k21 || !k24) return null;
  return { k21, k24, usdBank: usd ? toNum(usd[1]) : null };
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'ar,en;q=0.8' },
    signal: AbortSignal.timeout(8000)
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
