// tools/ForexTool.js — Live foreign-exchange rates via Yahoo Finance FX pairs
// (e.g. USDINR=X). This is why Aurelius previously couldn't answer "what's the
// dollar price in rupees" — we only had equity, crypto and commodity tools, so
// currency questions fell back to a generic web search the model often skipped.
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Friendly currency names / symbols → ISO 4217 codes.
const NAME_TO_CODE = {
  dollar: 'USD', dollars: 'USD', usd: 'USD', 'us dollar': 'USD', 'american dollar': 'USD', buck: 'USD', bucks: 'USD', '$': 'USD',
  rupee: 'INR', rupees: 'INR', inr: 'INR', 'indian rupee': 'INR', 'indian rupees': 'INR', '₹': 'INR',
  euro: 'EUR', euros: 'EUR', eur: 'EUR', '€': 'EUR',
  pound: 'GBP', pounds: 'GBP', gbp: 'GBP', sterling: 'GBP', 'british pound': 'GBP', '£': 'GBP',
  yen: 'JPY', jpy: 'JPY', 'japanese yen': 'JPY', '¥': 'JPY',
  yuan: 'CNY', renminbi: 'CNY', rmb: 'CNY', cny: 'CNY', 'chinese yuan': 'CNY',
  'canadian dollar': 'CAD', cad: 'CAD', 'aussie dollar': 'AUD', 'australian dollar': 'AUD', aud: 'AUD',
  franc: 'CHF', 'swiss franc': 'CHF', chf: 'CHF',
  dirham: 'AED', aed: 'AED', riyal: 'SAR', sar: 'SAR',
  real: 'BRL', brl: 'BRL', ruble: 'RUB', rouble: 'RUB', rub: 'RUB',
  won: 'KRW', krw: 'KRW', 'singapore dollar': 'SGD', sgd: 'SGD',
  'hong kong dollar': 'HKD', hkd: 'HKD', peso: 'MXN', mxn: 'MXN',
  rand: 'ZAR', zar: 'ZAR', lira: 'TRY', try: 'TRY', bitcoin: 'BTC', btc: 'BTC'
};

const CODE_RX = /^[A-Za-z]{3}$/;

/** Resolve any currency word/symbol/code to a 3-letter ISO code. */
function toCode(raw) {
  if (!raw) return null;
  const key = String(raw).toLowerCase().trim();
  if (NAME_TO_CODE[key]) return NAME_TO_CODE[key];
  if (CODE_RX.test(key)) return key.toUpperCase();
  // Partial match — e.g. "indian rupee note" → rupee
  for (const name of Object.keys(NAME_TO_CODE)) {
    if (key.includes(name)) return NAME_TO_CODE[name];
  }
  return null;
}

// Default quote currency when only one currency is named (e.g. "dollar price").
const DEFAULT_QUOTE = 'INR'; // this deployment's users care about USD→INR most

/**
 * Parse the tool input into { from, to } ISO codes. Accepts:
 *   {from:'USD', to:'INR'} | "USD/INR" | "USD to INR" | "USD INR"
 *   "dollar price in rupees" | "dollar" (→ USD/INR via default quote)
 */
function parsePair(input) {
  let from = null, to = null, base = null, quote = null;
  if (input && typeof input === 'object') {
    from = input.from || input.base; to = input.to || input.quote;
  } else if (typeof input === 'string') {
    try {
      const p = JSON.parse(input);
      if (p && typeof p === 'object') { from = p.from || p.base; to = p.to || p.quote; }
    } catch { /* plain string — parse below */ }
  }
  base = toCode(from); quote = toCode(to);

  if ((!base || !quote) && typeof input === 'string') {
    // Pull currency tokens out of free text in order of appearance.
    const cleaned = input.replace(/[/\-]/g, ' ').toLowerCase();
    const found = [];
    // 3-letter codes first
    for (const m of cleaned.matchAll(/\b[a-z]{3}\b/g)) {
      const c = m[0].toUpperCase();
      if (CODE_RX.test(c) && !found.includes(c)) found.push(c);
    }
    // then named currencies (longest names first so "indian rupee" wins over "rupee")
    for (const name of Object.keys(NAME_TO_CODE).sort((a, b) => b.length - a.length)) {
      if (cleaned.includes(name)) { const c = NAME_TO_CODE[name]; if (!found.includes(c)) found.push(c); }
    }
    if (!base && found[0]) base = found[0];
    if (!quote && found[1]) quote = found[1];
  }

  if (base && !quote) quote = base === DEFAULT_QUOTE ? 'USD' : DEFAULT_QUOTE;
  if (!base && quote) base = quote === 'USD' ? DEFAULT_QUOTE : 'USD';
  return { from: base, to: quote };
}

async function fetchRate(from, to) {
  const symbol = `${from}${to}=X`;
  const res = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
    { params: { interval: '1d', range: '1d' }, headers: { 'User-Agent': UA }, timeout: 10000 }
  );
  const r = res.data?.chart?.result?.[0];
  if (!r || !r.meta) throw new Error(`No FX data for ${symbol}`);
  const meta = r.meta;
  const rate = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose || meta.previousClose;
  const change = prev ? +(rate - prev).toFixed(4) : 0;
  const changePercent = prev ? +((change / prev) * 100).toFixed(2) : 0;
  return {
    pair: `${from}/${to}`,
    from, to,
    rate,
    change,
    changePercent,
    description: `1 ${from} = ${rate} ${to}`,
    source: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
    timestamp: new Date().toISOString()
  };
}

/**
 * Look up a live exchange rate.
 * @param {string|object} input - see parsePair() for accepted forms
 */
async function execute(input) {
  const { from, to } = parsePair(input);
  if (!from || !to) {
    return { error: 'Could not identify the currencies. Try {"from":"USD","to":"INR"} or "USD to INR".' };
  }
  if (from === to) {
    return { pair: `${from}/${to}`, from, to, rate: 1, description: `1 ${from} = 1 ${to}` };
  }
  try {
    return await fetchRate(from, to);
  } catch (err) {
    return { error: `Yahoo Finance FX error for ${from}/${to}: ${err.message}` };
  }
}

module.exports = { execute };
