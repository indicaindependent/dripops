// ════════════════════════════════════════════════════════════════════
// tuck-cache-refresh — twice-daily background ingest for Tuck
// ════════════════════════════════════════════════════════════════════
//
// Cron: 0 10,17 * * 1-5  (6 AM + 1 PM ET, weekdays)
//
// Pre-computes and caches:
//   - cache:macro:current        (Yahoo Finance — 11 indicators)
//   - cache:prices:current       (Yahoo Finance — 12 watchlist tickers, enriched)
//   - cache:tucks-score:current  (TRADEDESK_DB.tucks_scores)
//   - cache:sector-heat:current  (grouped sector momentum)
//
// Storage: TUCK_KV (hot reads) + TRADEDESK_DB.tuck_snapshots (historical)
// ════════════════════════════════════════════════════════════════════

const WATCHLIST = ['NVDA','NET','AVGO','QCOM','MU','INTC','MP','XLE','USO','KTOS','SOXX','QQQ'];
const UA = { "User-Agent": "Mozilla/5.0 (compatible; TuckCacheRefresh/1.0)" };

const NAMES = { NVDA:"NVIDIA", NET:"Cloudflare", AVGO:"Broadcom", QCOM:"Qualcomm", MU:"Micron", INTC:"Intel", MP:"MP Materials", XLE:"Energy Sector ETF", USO:"US Oil Fund", KTOS:"Kratos Defense", SOXX:"Semiconductor ETF", QQQ:"Nasdaq-100 ETF" };
const CATS = { NVDA:"semiconductor", NET:"infrastructure", AVGO:"semiconductor", QCOM:"semiconductor", MU:"semiconductor", INTC:"semiconductor", MP:"defense", XLE:"energy", USO:"energy", KTOS:"defense", SOXX:"etf", QQQ:"etf" };
const CORR = { NVDA:"AI/data center", NET:"edge/AI compute", AVGO:"AI accelerator", QCOM:"China/Taiwan", INTC:"China/Taiwan", MP:"China/rare earths", MU:"memory cycle", XLE:"oil price", USO:"oil price", KTOS:"defense spending", SOXX:"semi cycle", QQQ:"tech mega-caps" };
const SHARES = { NVDA:24400000000, NET:348000000, AVGO:4690000000, QCOM:1100000000, MU:1120000000, INTC:4780000000, MP:165000000, XLE:305000000, USO:89700000, KTOS:158000000, SOXX:0, QQQ:0 };

const JSON_H = { 'Content-Type': 'application/json' };
function j(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: JSON_H }); }

async function yf(sym, range = '5d') {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=${range}`, { headers: UA });
    if (!r.ok) return null;
    const d = await r.json();
    return d.chart?.result?.[0]?.meta || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────
// MACRO refresh — parallelized (was sequential before)
// ─────────────────────────────────────────────────────────────────────
async function refreshMacro(env) {
  const symbols = {
    fed_rate:'%5EIRX', oil:'CL%3DF', tnx:'%5ETNX', dxy:'DX-Y.NYB',
    twoy:'%5ETWOYEAR', vix:'%5EVIX', gold:'GC%3DF', btc:'BTC-USD', copper:'HG%3DF'
  };
  const results = await Promise.allSettled(
    Object.entries(symbols).map(async ([k, sym]) => [k, await yf(sym)])
  );
  const map = {};
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && r.value[1]) {
      map[r.value[0]] = r.value[1];
    }
  }
  const trendOf = m => m.regularMarketPrice > (m.chartPreviousClose || m.regularMarketPrice) ? 'up' : 'down';
  const out = {};
  if (map.fed_rate) out.fed_rate = parseFloat(map.fed_rate.regularMarketPrice.toFixed(2));
  if (map.oil)     { out.oil_price = map.oil.regularMarketPrice; out.oil_trend = trendOf(map.oil); }
  if (map.tnx)     { out.treasury_10y = parseFloat(map.tnx.regularMarketPrice.toFixed(3)); out.treasury_trend = trendOf(map.tnx); }
  if (map.dxy)     { out.dxy = parseFloat(map.dxy.regularMarketPrice.toFixed(2)); out.dxy_trend = trendOf(map.dxy); }
  if (map.twoy)    out.treasury_2y = parseFloat(map.twoy.regularMarketPrice.toFixed(3));
  if (map.vix)     { out.vix = parseFloat(map.vix.regularMarketPrice.toFixed(2)); out.vix_trend = trendOf(map.vix); }
  if (map.gold)    { out.gold = parseFloat(map.gold.regularMarketPrice.toFixed(2)); out.gold_trend = trendOf(map.gold); }
  if (map.btc)     { out.btc = parseFloat(map.btc.regularMarketPrice.toFixed(0)); out.btc_trend = trendOf(map.btc); }
  if (map.copper)  { out.copper = parseFloat(map.copper.regularMarketPrice.toFixed(3)); out.copper_trend = trendOf(map.copper); }
  
  // BLS data — manually updated, refresh from official source if available
  out.cpi = 2.3; out.cpi_trend = 'down';
  out.unemployment = 4.2; out.unemp_trend = 'up';
  out.data_note = `Refreshed ${new Date().toISOString()}. CPI/unemp: BLS latest release. Markets: real-time at cron run.`;
  out._cached_at = new Date().toISOString();
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// PRICES refresh — pulls upstream base + Yahoo enrichment
// ─────────────────────────────────────────────────────────────────────
async function refreshPrices(env) {
  const quotes = {};
  
  // Try upstream price worker first if configured
  if (env.PRICE_URL) {
    try {
      const baseRes = await fetch(env.PRICE_URL + "/prices");
      if (baseRes.ok) {
        const baseData = await baseRes.json();
        Object.assign(quotes, baseData.quotes || {});
      }
    } catch {}
  }
  
  // Enrich/fill from Yahoo for all watchlist tickers IN PARALLEL
  await Promise.allSettled(WATCHLIST.map(async (ticker) => {
    const meta = await yf(ticker, '2d');
    if (!meta) return;
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose || meta.regularMarketPreviousClose;
    const chgPct = prev ? (price - prev) / prev * 100 : 0;
    const w52h = meta["52WeekHigh"] || meta.fiftyTwoWeekHigh;
    const w52l = meta["52WeekLow"] || meta.fiftyTwoWeekLow;
    const vol = meta.regularMarketVolume;
    const mcap = SHARES[ticker] ? Math.round(price * SHARES[ticker]) : null;
    if (!quotes[ticker]) {
      quotes[ticker] = {
        price, change_pct: parseFloat(chgPct.toFixed(2)),
        week52_low: w52l, week52_high: w52h, volume: vol, market_cap: mcap,
        name: NAMES[ticker], category: CATS[ticker], correlation: CORR[ticker]
      };
    } else {
      if (quotes[ticker].week52_low == null)  quotes[ticker].week52_low = w52l;
      if (quotes[ticker].week52_high == null) quotes[ticker].week52_high = w52h;
      if (quotes[ticker].volume == null)      quotes[ticker].volume = vol;
      if (quotes[ticker].market_cap == null)  quotes[ticker].market_cap = mcap;
      if (quotes[ticker].name == null)        quotes[ticker].name = NAMES[ticker];
      if (quotes[ticker].category == null)    quotes[ticker].category = CATS[ticker];
      if (quotes[ticker].correlation == null) quotes[ticker].correlation = CORR[ticker];
    }
  }));
  
  return { quotes, ts: new Date().toISOString(), _cached_at: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────────────
// TUCK'S SCORE refresh — read latest leaderboard from D1
// ─────────────────────────────────────────────────────────────────────
async function refreshTucksScore(env) {
  try {
    const q = await env.TRADEDESK_DB.prepare(
      `SELECT * FROM tucks_scores WHERE score_date = (SELECT MAX(score_date) FROM tucks_scores) ORDER BY total_score DESC`
    ).all();
    const rows = (q.results || []).map(r => {
      let breakdown = {}, components = {};
      try { breakdown = JSON.parse(r.breakdown_json || '{}'); } catch {}
      try { components = JSON.parse(r.components_json || '{}'); } catch {}
      return { ...r, breakdown, components };
    });
    return { ok: true, scores: rows, count: rows.length, _cached_at: new Date().toISOString() };
  } catch (e) {
    return { ok: false, scores: [], error: String(e).slice(0,200), _cached_at: new Date().toISOString() };
  }
}

// ─────────────────────────────────────────────────────────────────────
// SECTOR HEAT refresh — group watchlist by sector + 5d momentum
// ─────────────────────────────────────────────────────────────────────
async function refreshSectorHeat(env, pricesData) {
  // Use the prices we just refreshed for cross-call efficiency
  const quotes = pricesData?.quotes || {};
  const SECTOR_MAP = {
    semiconductor: ['NVDA','AVGO','QCOM','MU','INTC','SOXX'],
    defense:       ['MP','KTOS'],
    energy:        ['XLE','USO'],
    infrastructure:['NET'],
    broad_tech:    ['QQQ']
  };
  
  // For each ticker fetch 5d history (parallel)
  const histResults = await Promise.allSettled(WATCHLIST.map(async (ticker) => {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`, { headers: UA });
      if (!r.ok) return [ticker, null];
      const d = await r.json();
      const meta = d.chart?.result?.[0]?.meta;
      const closes = d.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      const valid = closes.filter(c => c != null);
      if (valid.length < 2) return [ticker, null];
      const first = valid[0], last = valid[valid.length - 1];
      const pct = ((last - first) / first) * 100;
      return [ticker, { momentum_5d: parseFloat(pct.toFixed(2)), price: last }];
    } catch { return [ticker, null]; }
  }));
  
  const tickerData = {};
  for (const r of histResults) {
    if (r.status === 'fulfilled' && r.value[1]) tickerData[r.value[0]] = r.value[1];
  }
  
  const sectors = {};
  for (const [sector, tickers] of Object.entries(SECTOR_MAP)) {
    const validTickers = tickers.filter(t => tickerData[t]);
    if (!validTickers.length) continue;
    const tickerList = validTickers.map(t => ({
      ticker: t,
      momentum_5d: tickerData[t].momentum_5d,
      price: tickerData[t].price,
      // current change % from prices cache for color
      change_pct: quotes[t]?.change_pct ?? 0,
    }));
    const avgMomentum = tickerList.reduce((s,t)=>s+t.momentum_5d,0) / tickerList.length;
    sectors[sector] = {
      avg_momentum_5d: parseFloat(avgMomentum.toFixed(2)),
      tickers: tickerList.sort((a,b)=>b.momentum_5d-a.momentum_5d)
    };
  }
  
  return { ok: true, sectors, _cached_at: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────────────
// MAIN REFRESH — runs all 4 in parallel
// ─────────────────────────────────────────────────────────────────────
async function refreshAll(env) {
  const start = Date.now();
  
  // Run macro, prices, tucks-score in parallel
  const [macroR, pricesR, scoreR] = await Promise.allSettled([
    refreshMacro(env),
    refreshPrices(env),
    refreshTucksScore(env)
  ]);
  
  const macro = macroR.status === 'fulfilled' ? macroR.value : { _error: String(macroR.reason).slice(0,200) };
  const prices = pricesR.status === 'fulfilled' ? pricesR.value : { _error: String(pricesR.reason).slice(0,200) };
  const tucksScore = scoreR.status === 'fulfilled' ? scoreR.value : { _error: String(scoreR.reason).slice(0,200) };
  
  // Sector heat USES prices internally — run after prices is ready
  const sectorR = await refreshSectorHeat(env, prices).catch(e => ({ _error: String(e).slice(0,200) }));
  
  // Store all in KV with 24h TTL (refreshed twice daily = 12h gap, 24h ensures continuity)
  await Promise.all([
    env.TUCK_KV.put('cache:macro:current', JSON.stringify(macro), { expirationTtl: 86400 }),
    env.TUCK_KV.put('cache:prices:current', JSON.stringify(prices), { expirationTtl: 86400 }),
    env.TUCK_KV.put('cache:tucks-score:current', JSON.stringify(tucksScore), { expirationTtl: 86400 }),
    env.TUCK_KV.put('cache:sector-heat:current', JSON.stringify(sectorR), { expirationTtl: 86400 }),
  ]);
  
  // Also append a historical snapshot for charts later
  try {
    await env.TRADEDESK_DB.prepare(
      `CREATE TABLE IF NOT EXISTS tuck_snapshots (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         snapshot_at TEXT NOT NULL,
         macro_json TEXT, prices_json TEXT, sector_heat_json TEXT
       )`
    ).run().catch(()=>{});
    await env.TRADEDESK_DB.prepare(
      `INSERT INTO tuck_snapshots (snapshot_at, macro_json, prices_json, sector_heat_json) VALUES (?, ?, ?, ?)`
    ).bind(new Date().toISOString(), JSON.stringify(macro), JSON.stringify(prices), JSON.stringify(sectorR)).run();
  } catch (e) { /* nonfatal */ }
  
  const elapsed = Date.now() - start;
  return {
    ok: true,
    elapsed_ms: elapsed,
    refreshed_at: new Date().toISOString(),
    macro_keys: Object.keys(macro).length,
    prices_tickers: Object.keys(prices?.quotes || {}).length,
    tucks_score_count: tucksScore?.scores?.length || 0,
    sector_count: Object.keys(sectorR?.sectors || {}).length,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Worker entry
// ─────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    if (path === '/health') return j({ ok: true, worker: 'tuck-cache-refresh', ts: new Date().toISOString() });
    
    if (path === '/refresh' && request.method === 'POST') {
      const auth = request.headers.get('authorization') || '';
      if (auth !== `Bearer ${env.REFRESH_SECRET}`) return j({ error: 'unauthorized' }, 401);
      const result = await refreshAll(env);
      return j(result);
    }
    
    if (path === '/preview' && request.method === 'GET') {
      // Public read-only preview of current cache state
      const [macro, prices, score, sector] = await Promise.all([
        env.TUCK_KV.get('cache:macro:current', 'json'),
        env.TUCK_KV.get('cache:prices:current', 'json'),
        env.TUCK_KV.get('cache:tucks-score:current', 'json'),
        env.TUCK_KV.get('cache:sector-heat:current', 'json'),
      ]);
      return j({
        macro_cached_at: macro?._cached_at,
        prices_cached_at: prices?._cached_at,
        prices_ticker_count: Object.keys(prices?.quotes || {}).length,
        tucks_score_cached_at: score?._cached_at,
        tucks_score_count: score?.scores?.length || 0,
        sector_cached_at: sector?._cached_at,
        sector_count: Object.keys(sector?.sectors || {}).length,
      });
    }
    
    return j({ worker: 'tuck-cache-refresh', routes: ['/health', '/preview', 'POST /refresh'] });
  },
  
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      console.log('[tuck-cache-refresh] cron fired at', new Date().toISOString());
      const result = await refreshAll(env);
      console.log('[tuck-cache-refresh] done:', JSON.stringify(result).slice(0,500));
      
      // Telegram notify on success/failure
      try {
        const ok = result.macro_keys >= 5 && result.prices_tickers >= 8;
        const emoji = ok ? '✅' : '⚠️';
        const msg = `${emoji} Tuck cache refresh\n\n` +
          `⏱  ${result.elapsed_ms}ms\n` +
          `📊 Macro: ${result.macro_keys} indicators\n` +
          `💹 Prices: ${result.prices_tickers}/12 tickers\n` +
          `🎯 Tuck's Score: ${result.tucks_score_count} ranked\n` +
          `🔥 Sectors: ${result.sector_count} groups`;
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_PETE_ID, text: msg })
        });
      } catch (e) { console.error('[tuck-cache-refresh] tg failed:', e.message); }
    })());
  }
};