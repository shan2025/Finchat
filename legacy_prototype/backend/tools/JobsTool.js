// tools/JobsTool.js — Real job listings, primarily for Rasha (Career Strategist).
// Uses Remotive's public JSON API (remote/tech roles) plus a DDG web-search fallback
// for site-specific queries like "IBM careers India". Returns titles, companies,
// locations, and DIRECT application URLs so the agent can cite real sources.
const axios = require('axios');
const SearchTool = require('./SearchTool');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

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
async function fromRemotive({ role, company, limit }) {
  const params = { limit: Math.min(limit || 8, 15) };
  if (role) params.search = role;
  if (company) params.company_name = company;
  const res = await axios.get('https://remotive.com/api/remote-jobs', {
    params,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    timeout: 12000
  });
  const jobs = res.data && Array.isArray(res.data.jobs) ? res.data.jobs : [];
  return jobs.map(j => ({
    source: 'remotive',
    title: j.title,
    company: j.company_name,
    location: j.candidate_required_location || 'Remote',
    seniority: j.job_type || null,
    url: j.url,
    postedAt: j.publication_date
  }));
}

/**
 * Fallback path — use the real web search to find real careers pages.
 * We build a targeted query so the URLs come back from actual employer sites.
 */
async function fromWebSearch({ role, company, region }) {
  const parts = [];
  if (role) parts.push(role);
  if (company) parts.push(company);
  if (region) parts.push(region);
  parts.push('jobs careers');
  const query = parts.join(' ');
  const r = await SearchTool.execute({ query, limit: 6 });
  return (r.results || []).map(x => ({
    source: 'web',
    title: x.title,
    company: company || null,
    location: region || null,
    url: x.url,
    snippet: x.snippet
  }));
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

  // 1. Remotive — reliable JSON API, remote-tech-heavy
  try {
    const remo = await fromRemotive({ role: normalizedRole, company, limit });
    for (const j of remo) {
      if (j.url && !seen.has(j.url)) { seen.add(j.url); results.push(j); }
    }
  } catch (err) {
    console.warn(`⚠️ JobsTool: Remotive failed: ${err.message}`);
  }

  // 2. Web-search fallback: if role includes specific company/region hints,
  //    always augment; if Remotive returned nothing, fall back entirely.
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
      ? 'No listings surfaced. Try broadening the role name, or check the company careers page directly.'
      : 'Each result includes a direct URL — cite them in your response.'
  };
}

module.exports = { execute };
