// tools/JobsTool.js — Real job listings, primarily for Rasha (Career Strategist).
// Uses Remotive's public JSON API (remote/tech roles) plus board-targeted web
// searches (LinkedIn, Indeed, Naukri, Wellfound…) so region-specific queries like
// "product manager India" actually surface local postings instead of only remote
// US-centric roles. Returns titles, companies, locations, and DIRECT application
// URLs so the agent can cite real sources.
const axios = require('axios');
const SearchTool = require('./SearchTool');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

// Job boards to target with site-scoped searches. India-heavy boards (Naukri,
// Foundit, Instahyre, Indeed India) are used when the region reads as India;
// otherwise the global set. LinkedIn + Wellfound span both. Each board also carries
// a friendly label so the agent can tell the user WHERE the posting lives.
const INDIA_BOARDS = [
  { site: 'linkedin.com/jobs', label: 'LinkedIn' },
  { site: 'naukri.com', label: 'Naukri' },
  { site: 'in.indeed.com', label: 'Indeed India' },
  { site: 'foundit.in', label: 'Foundit' },
  { site: 'instahyre.com', label: 'Instahyre' },
  { site: 'wellfound.com', label: 'Wellfound' }
];
const GLOBAL_BOARDS = [
  { site: 'linkedin.com/jobs', label: 'LinkedIn' },
  { site: 'indeed.com', label: 'Indeed' },
  { site: 'wellfound.com', label: 'Wellfound' },
  { site: 'glassdoor.com', label: 'Glassdoor' }
];

// Does the requested region read as India? (country name, common cities, or "IN").
const INDIA_RE = /\b(india|indian|bangalore|bengaluru|mumbai|delhi|ncr|gurgaon|gurugram|noida|hyderabad|pune|chennai|kolkata|remote india|in)\b/i;

function boardsForRegion(region) {
  return region && INDIA_RE.test(region) ? INDIA_BOARDS : GLOBAL_BOARDS;
}

// Guess a friendly board label from a result URL, for results that came back on a
// general (non-site-scoped) query.
function boardLabelFromUrl(url) {
  const all = [...INDIA_BOARDS, ...GLOBAL_BOARDS];
  const hit = all.find(b => (url || '').includes(b.site.split('/')[0]));
  return hit ? hit.label : null;
}

// Normalize free-text role hints to Remotive category slugs / search terms.
const ROLE_HINTS = {
  'data science': 'data',
  'data scientist': 'data',
  'data analyst': 'analyst',
  'ml': 'machine learning',
  'ai engineer': 'machine learning',
  'ai/ml': 'machine learning',
  'ba': 'business analyst',
  'product analyst': 'analyst',
  'product manager': 'product',
  'project manager': 'project manager',
  'business analyst': 'business analyst',
  'analyst': 'analyst'
};

function normalizeRole(r) {
  if (!r) return '';
  const key = r.toLowerCase().trim();
  return ROLE_HINTS[key] || key;
}

/**
 * Query Remotive for real remote-first / tech job listings.
 */
async function fromRemotive({ role, company, region, limit }) {
  const params = { limit: Math.min(limit || 8, 15) };
  if (role) params.search = role;
  if (company) params.company_name = company;
  const res = await axios.get('https://remotive.com/api/remote-jobs', {
    params,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    timeout: 12000
  });
  const jobs = res.data && Array.isArray(res.data.jobs) ? res.data.jobs : [];
  let mapped = jobs.map(j => ({
    source: 'remotive',
    board: 'Remotive',
    title: j.title,
    company: j.company_name,
    location: j.candidate_required_location || 'Remote',
    seniority: j.job_type || null,
    url: j.url,
    postedAt: j.publication_date
  }));

  // Remotive is remote-first and global — when the user asked for a specific
  // region, keep only postings that welcome that region (or are worldwide/anywhere),
  // so an "India" search doesn't return US-only remote roles.
  if (region) {
    const rx = new RegExp(region.split(/[,\s]+/).filter(Boolean).join('|'), 'i');
    mapped = mapped.filter(j => {
      const loc = j.location || '';
      return rx.test(loc) || /worldwide|anywhere/i.test(loc);
    });
  }
  return mapped;
}

/**
 * Fallback / augmentation path — run board-targeted web searches so results come
 * from actual job boards and employer careers pages. Region picks the board set
 * (India vs global); each board is queried with a `site:` scope, plus one general
 * query, and the results are merged. This is what makes "jobs in India" work — the
 * plain Remotive API only knows remote-first roles.
 */
async function fromWebSearch({ role, company, region }) {
  const boards = boardsForRegion(region);
  const base = [role, company, region].filter(Boolean).join(' ').trim();
  const out = [];

  // Query the top boards (cap at 3 to bound metered search calls), then one
  // general query as a catch-all for employer careers pages.
  // Cap at the top 2 boards + 1 general query to bound metered/free-tier search
  // credits and avoid burst throttling within a single job search.
  const queries = boards.slice(0, 2).map(b => ({
    board: b.label,
    // domain to gate on, so a search provider's Wikipedia/degraded fallback
    // (which ignores `site:`) can't smuggle in irrelevant encyclopedia pages.
    domain: b.site.split('/')[0],
    query: `site:${b.site} ${base} jobs`
  }));
  queries.push({ board: null, domain: null, query: `${base} jobs careers hiring`.trim() });

  const settled = await Promise.allSettled(
    queries.map(q => SearchTool.execute({ query: q.query, limit: 4 }))
  );

  settled.forEach((res, i) => {
    if (res.status !== 'fulfilled') return;
    const { board, domain } = queries[i];
    for (const x of res.value.results || []) {
      // For a site-scoped query, keep only URLs actually on that board's domain.
      if (domain && !(x.url || '').includes(domain)) continue;
      // Never surface encyclopedia fallbacks as if they were job postings.
      if (/wikipedia\.org/i.test(x.url || '')) continue;
      out.push({
        source: 'web',
        board: board || boardLabelFromUrl(x.url),
        title: x.title,
        company: company || null,
        location: region || null,
        url: x.url,
        snippet: x.snippet
      });
    }
  });
  return out;
}

/**
 * Execute a job search. Merges Remotive + web results, dedupes by URL, caps total.
 *
 * @param {string|object} input - role, or {role, company, region, limit}
 */
async function execute(input) {
  let role = '', company = '', region = '', limit = 8;
  if (typeof input === 'string') {
    try {
      const p = JSON.parse(input);
      role = p.role || p.query || input;
      company = p.company || '';
      region = p.region || p.location || '';
      if (p.limit) limit = +p.limit;
    } catch {
      role = input.trim();
    }
  } else if (input && typeof input === 'object') {
    role = input.role || input.query || '';
    company = input.company || '';
    region = input.region || input.location || '';
    if (input.limit) limit = +input.limit;
  }

  const normalizedRole = normalizeRole(role);
  const results = [];
  const seen = new Set();

  // 1. Remotive — reliable JSON API, remote-tech-heavy. Skip it for a concrete
  //    non-remote region (e.g. India), where its remote-only index rarely helps
  //    and the board searches below are the real source.
  const regionIsLocal = region && !/remote|anywhere|worldwide/i.test(region);
  if (!regionIsLocal) {
    try {
      const remo = await fromRemotive({ role: normalizedRole, company, region, limit });
      for (const j of remo) {
        if (j.url && !seen.has(j.url)) { seen.add(j.url); results.push(j); }
      }
    } catch (err) {
      console.warn(`⚠️ JobsTool: Remotive failed: ${err.message}`);
    }
  }

  // 2. Board-targeted web search: always run when a region/company was given
  //    (that's where local postings live), or to backfill thin Remotive results.
  const needSearch = results.length < 4 || company || region;
  if (needSearch) {
    try {
      const web = await fromWebSearch({ role, company, region });
      for (const j of web) {
        if (j.url && !seen.has(j.url)) { seen.add(j.url); results.push(j); }
      }
    } catch (err) {
      console.warn(`⚠️ JobsTool: Web fallback failed: ${err.message}`);
    }
  }

  return {
    query: { role, company, region },
    count: Math.min(results.length, limit),
    results: results.slice(0, limit),
    tip: results.length === 0
      ? `No listings surfaced${region ? ` for "${region}"` : ''}. Web search may be rate-limited — retry, broaden the role, or point the user to ${(boardsForRegion(region)[1] || {}).label || 'a job board'} directly.`
      : 'Each result includes a direct URL and a "board" label — cite them in your response.'
  };
}

module.exports = { execute };
