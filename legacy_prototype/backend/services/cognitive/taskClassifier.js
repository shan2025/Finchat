// services/cognitive/taskClassifier.js — what kind of question is this?
//
// Everything the Agent Map learns is bucketed by this label: per-agent
// profiles, the history half of Plato's routing score, route yield, and the
// learned district-to-district roads. A wrong label puts a run's evidence in
// the wrong bucket, so every one of those numbers inherits the error.
//
// It used to be six regexes where the FIRST match won. Any goal mentioning a
// price was "markets" even when it was about job salaries; "what is" made
// anything "research"; and there was no bucket at all for careers, learning or
// system questions, so Rasha, Feynman and Hopper had every run filed under
// "general" and no profile worth the name.
//
// Now every task type scores every goal. Unambiguous domain words weigh 2
// ("stock", "resume", "arxiv"), generic ones weigh 1 ("latest", "explain",
// "market" — as in "job market"). Each distinct term counts once, the highest
// score wins, ties go to the more specific domain (TIE_ORDER), and a goal that
// scores nothing is "general".
//
// Deliberately lexical, local and deterministic: it runs over thousands of past
// goals every time profiles are rebuilt, so it cannot make a network call per
// goal, and a deterministic label is what makes history comparable run to run.
// test/task-classifier.test.js holds the labelled examples it must get right.

const LEXICON = {
  markets: {
    2: ['stock', 'stocks', 'share price', 'shares', 'ticker', 'crypto', 'bitcoin', 'btc', 'ethereum', 'eth',
      'solana', 'forex', 'exchange rate', 'currency', 'commodity', 'commodities', 'gold', 'silver', 'crude',
      'equity', 'equities', 'trading', 'valuation', 'earnings', 'nifty', 'sensex', 'nasdaq', 's&p', 'dow jones',
      'ipo', 'ipos', 'bullish', 'bearish', 'rally', 'sell-off', 'selloff', 'market cap', 'dividend', 'nse', 'bse'],
    1: ['price', 'prices', 'market', 'markets', 'oil', 'invest', 'investing', 'investment', 'buy', 'sell']
  },
  portfolio: {
    2: ['portfolio', 'my holdings', 'holdings', 'allocation', 'watchlist', 'rebalance', 'rebalancing',
      'diversify', 'diversified', 'diversification', 'my investments', 'net worth', 'how am i doing',
      'zerodha', 'binance account', 'unrealized', 'cost basis'],
    1: ['holding', 'position', 'positions', 'my money', 'what i own']
  },
  risk: {
    2: ['drawdown', 'volatility', 'volatile', 'hedge', 'hedging', 'downside', 'stress test', 'value at risk',
      'sharpe', 'sortino', 'calmar', 'exposure', 'risk contribution'],
    1: ['risk', 'risks', 'risky', 'safe', 'protect']
  },
  news: {
    2: ['news', 'headline', 'headlines', 'breaking', 'announced', 'announcement', 'controversy', 'scandal'],
    1: ['latest', 'today', 'recent', 'recently', 'update', 'updates', 'happening', 'this week', 'trends',
      'what happened']
  },
  research: {
    2: ['research', 'paper', 'papers', 'arxiv', 'study', 'studies', 'literature', 'whitepaper', 'deep dive',
      'benchmark', 'state of the art', 'peer-reviewed', 'neuroscience', 'neuromorphic'],
    1: ['architecture', 'frontier', 'evidence', 'findings']
  },
  learning: {
    2: ['teach me', 'explain like', 'eli5', 'in simple terms', 'help me understand', 'walk me through',
      'quiz me', 'what does it mean'],
    1: ['explain', 'simply', 'what is', 'what are', 'how does', 'how do', 'why does', 'meaning of',
      'difference between', 'concept']
  },
  careers: {
    2: ['job', 'jobs', 'resume', 'cv', 'career', 'hiring', 'interview', 'cover letter', 'internship', 'intern',
      'recruiter', 'job opening', 'openings', 'naukri', 'linkedin', 'apply for', 'job application',
      'fresher', 'notice period', 'ctc'],
    // "application" is only weak: "AI applications in fintech" is not a job hunt.
    1: ['role', 'roles', 'salary', 'company', 'companies', 'apply', 'skills', 'application', 'applications']
  },
  compliance: {
    2: ['compliance', 'compliant', 'regulation', 'regulatory', 'regulator', 'sebi', 'kyc', 'aml', 'disclosure',
      'suitability', 'audit', 'legal', 'lawsuit'],
    1: ['rule', 'rules', 'law', 'policy', 'governance', 'allowed']
  },
  system: {
    2: ['is atlas working', 'is aurelius working', 'is rasha working', 'is nova working', 'is plato working',
      'agent working', 'agents working', 'not working', 'broken', 'not responding', 'did not reply',
      "didn't reply", 'failed run', 'diagnose', 'diagnostics', 'stack trace', 'bug'],
    1: ['error', 'errors', 'failed', 'failing', 'crash', 'down', 'working']
  }
};

// Ties go to the more specific domain: "how risky is my portfolio" is a
// portfolio question that mentions risk, and "explain drawdown" with equal
// weight would be risk before learning only if the learning terms lost.
const TIE_ORDER = ['system', 'careers', 'portfolio', 'risk', 'compliance', 'markets', 'research', 'learning', 'news'];
const TASK_TYPES = [...TIE_ORDER, 'general'];

// Precompile once: whole-word/phrase matches, case-insensitive. Terms with
// punctuation (s&p, sell-off) are escaped literally.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMPILED = Object.fromEntries(Object.entries(LEXICON).map(([task, tiers]) => [
  task,
  Object.entries(tiers).flatMap(([w, terms]) => terms.map(term => ({
    term, weight: Number(w),
    re: new RegExp(`(^|[^a-z0-9])${escape(term)}(?=$|[^a-z0-9])`, 'i')
  })))
]));

/**
 * Score every task type for a goal. PURE.
 * @returns {{ task: string, scores: Object<string, number>, matched: Object<string, string[]> }}
 */
function scoreTasks(goal) {
  const g = String(goal || '').toLowerCase();
  const scores = {}, matched = {};
  for (const task of TIE_ORDER) {
    let s = 0; const hits = [];
    for (const { term, weight, re } of COMPILED[task]) {
      if (re.test(g)) { s += weight; hits.push(term); }
    }
    scores[task] = s; matched[task] = hits;
  }
  let task = 'general', best = 0;
  for (const t of TIE_ORDER) if (scores[t] > best) { best = scores[t]; task = t; }
  return { task, scores, matched };
}

/** The task type for a goal: the highest-scoring domain, or "general". PURE. */
function classifyTask(goal) {
  return scoreTasks(goal).task;
}

module.exports = { classifyTask, scoreTasks, TASK_TYPES, LEXICON };
