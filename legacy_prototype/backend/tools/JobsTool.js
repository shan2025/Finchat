// tools/JobsTool.js — Real job listings, primarily for Rasha (Career Strategist).
//
// Three sources, in descending order of how much you can trust a row:
//
//   1. Adzuna     — a real jobs API with an India endpoint. Structured rows:
//                   title, company, location, salary band, posting date, and a
//                   URL that points at ONE posting. Needs a free key.
//   2. Remotive   — a real API, but remote-first tech roles only, so it is
//                   skipped when the user named a concrete city.
//   3. Web search — `site:linkedin.com/jobs …` style queries. This is NOT an
//                   API into those boards: neither LinkedIn nor Indeed offers a
//                   public jobs API (LinkedIn's is partner-only, Indeed retired
//                   its Publisher API), so this is a search engine reading their
//                   pages, and a search engine returns whatever RANKS. That is
//                   usually a category page — "Business Analyst Jobs In
//                   Hyderabad — 2227 Vacancies" is an index, not a job.
//
// Results are therefore tagged `kind: 'posting' | 'listing_page'`, so the agent
// can say which is which instead of presenting a search page as an opening.
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

// Adzuna publishes one endpoint per country. Only the ones worth mapping from a
// free-text region are listed; an unrecognised region simply skips Adzuna
// rather than guessing a country and returning confidently wrong postings.
const ADZUNA_COUNTRIES = [
  [INDIA_RE, 'in'],
  [/\b(united states|usa|u\.s\.|america|new york|san francisco|seattle|austin|boston)\b/i, 'us'],
  [/\b(uk|united kingdom|england|london|manchester|scotland)\b/i, 'gb'],
  [/\b(canada|toronto|vancouver|montreal)\b/i, 'ca'],
  [/\b(australia|sydney|melbourne|brisbane)\b/i, 'au'],
  [/\b(singapore)\b/i, 'sg'],
  [/\b(germany|berlin|munich|deutschland)\b/i, 'de'],
  [/\b(netherlands|amsterdam)\b/i, 'nl']
];

function adzunaCountry(region) {
  if (!region) return null;
  const hit = ADZUNA_COUNTRIES.find(([rx]) => rx.test(region));
  return hit ? hit[1] : null;
}

function adzunaConfigured() {
  return Boolean((process.env.ADZUNA_APP_ID || '').trim() && (process.env.ADZUNA_APP_KEY || '').trim());
}

/**
 * Query Adzuna — the one source here that is an actual jobs API.
 *
 * Returns [] rather than throwing when unconfigured or when the region maps to
 * no country endpoint: this is one source among three, and a missing optional
 * key must degrade the search, not fail it.
 */
async function fromAdzuna({ role, company, region, limit, maxDaysOld }) {
  const country = adzunaCountry(region);
  if (!country || !adzunaConfigured()) return [];

  const params = {
    app_id: (process.env.ADZUNA_APP_ID || '').trim(),
    app_key: (process.env.ADZUNA_APP_KEY || '').trim(),
    results_per_page: Math.min(limit || 8, 20),
    what: [role, company].filter(Boolean).join(' ').trim(),
    // Adzuna's index keeps expired ads indefinitely — a default search for
    // "business analyst Bangalore" returned postings from 2020 and 2024
    // alongside this week's. Nobody can apply to those, and a daily hunt that
    // reports them looks broken.
    //
    // Bounding the window is enough on its own: measured, it moved the oldest
    // result from 2020 to 23 days ago while leaving the default RELEVANCE
    // ordering intact. `sort_by=date` also works but ranks a fresh irrelevant
    // ad above a good one from last week, and `sort_by=hybrid` — which reads
    // like the obvious answer — is not a value this API accepts and 400s.
    max_days_old: Math.min(Math.max(Number(maxDaysOld) || 60, 1), 365),
    'content-type': 'application/json'
  };
  // `where` is a place within the country. Passing the country name itself
  // narrows nothing and can return zero rows, so only send a real locality.
  const where = String(region).replace(/\b(india|indian|remote india)\b/gi, '').trim();
  if (where) params.where = where;

  const res = await axios.get(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`, {
    params, headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 12000
  });

  const rows = (res.data && Array.isArray(res.data.results)) ? res.data.results : [];
  return rows.map(j => ({
    source: 'adzuna',
    board: 'Adzuna',
    kind: 'posting',
    title: j.title ? String(j.title).replace(/<[^>]+>/g, '') : null,
    company: (j.company && j.company.display_name) || company || null,
    location: (j.location && j.location.display_name) || region || null,
    // A salary band is the single most useful thing a search result never has.
    salary: j.salary_min || j.salary_max
      ? { min: j.salary_min || null, max: j.salary_max || null, currency: country === 'in' ? 'INR' : null,
          predicted: j.salary_is_predicted === '1' }
      : null,
    contract: j.contract_time || j.contract_type || null,
    category: (j.category && j.category.label) || null,
    url: j.redirect_url,
    postedAt: j.created,
    snippet: j.description ? String(j.description).replace(/<[^>]+>/g, '').slice(0, 300) : null
  })).filter(j => j.url && j.title);
}

// Does this URL point at ONE job, or at a board's category/search page?
//
// A generic pattern is not good enough here. It passed
// "in.linkedin.com/jobs/business-analysts-experience-2-to-4-years-jobs-bengaluru"
// as a posting — an index page whose slug happens to carry digits — and every
// board has its own shape. So the boards we actually query are matched on their
// KNOWN posting form, which is a positive test rather than a guess:
//
//   linkedin  /jobs/view/<id>          everything else under /jobs/ is an index
//   naukri    /job-listings-<slug>-<id>
//   indeed    /viewjob?jk=<id> or /rc/clk
//   wellfound /jobs/<id>-<slug>        (/role/l/… is the browse page)
//   foundit   /job/<slug>
//   glassdoor /job-listing/<slug>
//
// Anything on a domain with no rule falls through to the generic heuristic,
// which is deliberately biased toward calling a page an index: mislabelling one
// real job as "browse this" costs a lead, while the reverse puts a search page
// into a shortlist and, downstream, into a cover letter.
const POSTING_RULES = [
  [/(^|\.)linkedin\.com/i, /\/jobs\/view\//i],
  [/(^|\.)naukri\.com/i, /\/job-listings-/i],
  [/(^|\.)indeed\.[a-z.]+/i, /\/(viewjob|rc\/clk)/i],
  [/(^|\.)wellfound\.com/i, /\/jobs\/\d/i],
  [/(^|\.)foundit\.in/i, /\/job\//i],
  [/(^|\.)glassdoor\.[a-z.]+/i, /\/job-listing\//i],
  [/(^|\.)instahyre\.com/i, /\/job\//i]
];

const INDEX_URL_RE = /(\/jobs-in-|-jobs-[a-z]+\/?$|\/job-vacancies|\/jobs\/search|\/browse|\/role\/l\/|\/q-[^/]*-jobs|\/[a-z0-9-]*-jobs\/?$|\?k=|\/careers\/?$)/i;

function classifyUrl(url = '') {
  const u = String(url);
  let host = '';
  try { host = new URL(u).hostname; } catch (e) { host = u; }

  for (const [domain, posting] of POSTING_RULES) {
    if (domain.test(host)) return posting.test(u) ? 'posting' : 'listing_page';
  }
  return INDEX_URL_RE.test(u) ? 'listing_page' : 'posting';
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
    kind: 'posting',
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
        // Search hits are pages, not rows. Say which kind of page it is.
        kind: classifyUrl(x.url),
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
  let role = '', company = '', region = '', limit = 8, maxDaysOld = null;
  const read = (p) => {
    role = p.role || p.query || role;
    company = p.company || '';
    region = p.region || p.location || '';
    if (p.limit) limit = +p.limit;
    if (p.maxDaysOld || p.max_days_old) maxDaysOld = +(p.maxDaysOld || p.max_days_old);
  };
  if (typeof input === 'string') {
    try {
      const p = JSON.parse(input);
      role = input;
      read(p);
    } catch {
      role = input.trim();
    }
  } else if (input && typeof input === 'object') {
    role = '';
    read(input);
  }

  const normalizedRole = normalizeRole(role);
  const results = [];
  const seen = new Set();

  // 1. Adzuna FIRST when the region maps to one of its country endpoints. It is
  //    the only source that returns individual postings with a company, a
  //    salary band and a date, so its rows should lead the list rather than
  //    being buried under whatever a search engine ranked.
  let adzunaError = null;
  try {
    const paid = await fromAdzuna({ role, company, region, limit, maxDaysOld });
    for (const j of paid) {
      if (j.url && !seen.has(j.url)) { seen.add(j.url); results.push(j); }
    }
  } catch (err) {
    adzunaError = err.message;
    console.warn(`⚠️ JobsTool: Adzuna failed: ${err.message}`);
  }

  // 2. Remotive — reliable JSON API, remote-tech-heavy. Skip it for a concrete
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

  // 3. Board-targeted web search: always run when a region/company was given
  //    (that's where local postings live), or to backfill thin API results.
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

  // Individual postings first, index pages last: a category page is a lead, not
  // an opening, and it should never be the first thing the user is shown.
  results.sort((a, b) => (a.kind === 'listing_page' ? 1 : 0) - (b.kind === 'listing_page' ? 1 : 0));

  const shown = results.slice(0, limit);
  const postings = shown.filter(j => j.kind !== 'listing_page').length;
  const indexPages = shown.length - postings;
  const country = adzunaCountry(region);

  return {
    query: { role, company, region },
    count: shown.length,
    postingCount: postings,
    listingPageCount: indexPages,
    results: shown,
    sources: {
      adzuna: !country ? 'skipped — region maps to no Adzuna country endpoint'
        : !adzunaConfigured() ? 'unconfigured — set ADZUNA_APP_ID and ADZUNA_APP_KEY for real postings with salary and posting date'
          : adzunaError ? `failed: ${adzunaError}` : `queried (${country})`,
      remotive: regionIsLocal ? 'skipped — remote-only index, and a specific city was requested' : 'queried',
      webSearch: needSearch ? 'queried' : 'skipped'
    },
    tip: shown.length === 0
      ? `No listings surfaced${region ? ` for "${region}"` : ''}. Web search may be rate-limited — retry, broaden the role, or point the user to ${(boardsForRegion(region)[1] || {}).label || 'a job board'} directly.`
      : indexPages
        ? `Cite each result's URL and board. ${indexPages} of these have "kind":"listing_page" — those are a board's SEARCH page, not a single opening. Present them as "browse these" and never as a specific job, and prefer "kind":"posting" rows for anything you shortlist or draft an application for.`
        : 'Each result is an individual posting — cite its URL and board.'
  };
}

module.exports = { execute, classifyUrl, adzunaCountry, adzunaConfigured };
