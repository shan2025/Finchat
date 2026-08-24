// test/jobs-tool.test.js — telling a job apart from a page about jobs.
//
// The jobs tool has no LinkedIn or Indeed API to call (neither offers a public
// one), so most non-API results come from `site:` web searches — and a search
// engine returns whatever ranks, which is almost always a board's category
// page. "Business Analyst Jobs In Hyderabad Secunderabad - 2227 Vacancies" was
// being reported to the user as an opening; it is an index of 2,227 of them.
//
// classifyUrl is what stops that, so it is worth pinning in both directions:
// a false 'posting' puts a search page in a shortlist, and a false
// 'listing_page' buries a real job at the bottom of the list.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { classifyUrl, adzunaCountry, adzunaConfigured } = require('../tools/JobsTool');

describe('classifyUrl', () => {
  test('board category and search pages are not openings', () => {
    const indexes = [
      'https://www.naukri.com/business-analyst-jobs-in-bangalore',
      'https://www.naukri.com/business-analyst-jobs',
      'https://www.naukri.com/functional-business-analyst-jobs',
      'https://www.linkedin.com/jobs/search?keywords=product%20manager',
      'https://in.indeed.com/q-business-analyst-jobs.html',
      'https://in.indeed.com/jobs?k=data%20analyst',
      'https://www.foundit.in/browse/analyst',
      'https://www.acme.com/careers',
      // Observed live, and misclassified as postings by the first version of
      // this: a digit anywhere in the slug defeated the generic pattern.
      'https://in.linkedin.com/jobs/business-analysts-experience-2-to-4-years-jobs-bengaluru',
      'https://in.linkedin.com/jobs/remote-business-analyst-jobs-greater-bengaluru-area',
      'https://www.linkedin.com/jobs/business-analyst-jobs-worldwide',
      'https://wellfound.com/role/l/business-analyst/bangalore'
    ];
    for (const url of indexes) {
      assert.equal(classifyUrl(url), 'listing_page', url);
    }
  });

  test('individual postings survive', () => {
    const postings = [
      'https://www.linkedin.com/jobs/view/3901234567',
      'https://in.indeed.com/viewjob?jk=a1b2c3d4e5f6',
      'https://www.naukri.com/job-listings-business-analyst-acme-bangalore-2-to-5-years-140825901234',
      'https://remotive.com/remote-jobs/data/senior-data-analyst-1234567',
      'https://www.adzuna.in/details/4812345678',
      'https://www.adzuna.in/land/ad/5837138896?se=abc&utm_medium=api',
      'https://wellfound.com/jobs/1234567-product-manager',
      'https://www.foundit.in/job/business-analyst-acme-bangalore-12345',
      // An employer's own ATS, which has no per-domain rule and must survive
      // the generic heuristic.
      'https://jobs.thermofisher.com/global/en/job/R-01360249/Senior-Business-Analyst'
    ];
    for (const url of postings) {
      assert.equal(classifyUrl(url), 'posting', url);
    }
  });
});

describe('adzunaCountry', () => {
  test('Indian regions and cities map to the India endpoint', () => {
    for (const r of ['India', 'bangalore', 'Bengaluru', 'Hyderabad', 'remote india', 'Mumbai, India']) {
      assert.equal(adzunaCountry(r), 'in', r);
    }
  });

  test('other supported regions map to their own endpoint', () => {
    assert.equal(adzunaCountry('London'), 'gb');
    assert.equal(adzunaCountry('United States'), 'us');
    assert.equal(adzunaCountry('Singapore'), 'sg');
  });

  test('an unmappable region skips Adzuna rather than guessing', () => {
    // Guessing a country would return real postings from the wrong place —
    // worse than returning none, because they look correct.
    assert.equal(adzunaCountry('Kathmandu'), null);
    assert.equal(adzunaCountry(''), null);
    assert.equal(adzunaCountry(null), null);
  });
});

describe('adzunaConfigured', () => {
  test('needs both halves of the credential', () => {
    const { ADZUNA_APP_ID: id, ADZUNA_APP_KEY: key } = process.env;
    try {
      process.env.ADZUNA_APP_ID = 'abc';
      delete process.env.ADZUNA_APP_KEY;
      assert.equal(adzunaConfigured(), false, 'an id with no key is not configured');
      process.env.ADZUNA_APP_KEY = 'def';
      assert.equal(adzunaConfigured(), true);
      process.env.ADZUNA_APP_ID = '   ';
      assert.equal(adzunaConfigured(), false, 'whitespace is not a credential');
    } finally {
      if (id === undefined) delete process.env.ADZUNA_APP_ID; else process.env.ADZUNA_APP_ID = id;
      if (key === undefined) delete process.env.ADZUNA_APP_KEY; else process.env.ADZUNA_APP_KEY = key;
    }
  });
});
