// services/cognitive/toolDistricts.js — the single source of truth mapping a
// tool to its knowledge "district" (the map region it lands in) and that
// district's tone ('a' analytical, 's' source, 'n' neutral). Shared by
// ExecutionTrace (map geometry / replay), BrainStream (live), and RouteStats
// (route-yield aggregation) so a scored leg, a replayed leg, and a live leg all
// resolve to exactly the same district.
const TOOL_DISTRICT = {
  stocks: ['markets', 'Markets', 'a'], crypto: ['markets', 'Markets', 'a'],
  forex: ['markets', 'Markets', 'a'], commodities: ['markets', 'Markets', 'a'],
  news: ['news', 'News & Sentiment', 's'], reddit: ['news', 'News & Sentiment', 's'],
  quora: ['news', 'News & Sentiment', 's'],
  paper: ['research', 'Research', 'a'], wikipedia: ['research', 'Research', 'a'],
  search: ['web', 'Web & Search', 's'], fetch: ['web', 'Web & Search', 's'],
  crawl: ['web', 'Web & Search', 's'],
  watchlist: ['portfolio', 'Portfolio', 's'], resume: ['portfolio', 'Portfolio', 's'],
  jobs: ['portfolio', 'Portfolio', 's'], portfolio: ['portfolio', 'Portfolio', 's'],
  applications: ['portfolio', 'Portfolio', 's'],
  signal: ['markets', 'Markets', 'a'], session: ['markets', 'Markets', 'a'],
  neural_map: ['knowledge', 'Knowledge', 'a'],
  notifications: ['ops', 'Operations', 'n'], apply_draft: ['ops', 'Operations', 'n'],
  mission: ['ops', 'Operations', 'n'], gmail: ['ops', 'Operations', 's'],
  bash: ['system', 'System', 'n'], file_read: ['system', 'System', 'n'],
  file_write: ['system', 'System', 'n'], file_edit: ['system', 'System', 'n'],
  glob: ['system', 'System', 'n']
};
const DEFAULT_DISTRICT = ['tools', 'Tools', 'n'];
// Generic tools every agent carries — they say nothing about where it lives.
const GENERIC_TOOLS = new Set(['search', 'fetch', 'crawl', 'mission']);

// An agent's home district: where its own non-generic tools mostly land.
// Returns { home: [id, name, tone] | null, districts: [{ d, n }] by count desc };
// home is null for an agent with only generic tools (Plato — it lives at the hub).
function homeDistrict(tools) {
  const tally = new Map();
  for (const t of Array.isArray(tools) ? tools : []) {
    if (GENERIC_TOOLS.has(t)) continue;
    const d = TOOL_DISTRICT[t] || DEFAULT_DISTRICT;
    const cur = tally.get(d[0]) || { d, n: 0 };
    cur.n++; tally.set(d[0], cur);
  }
  const districts = [...tally.values()].sort((a, b) => b.n - a.n);
  return { home: districts.length ? districts[0].d : null, districts };
}

module.exports = { TOOL_DISTRICT, DEFAULT_DISTRICT, GENERIC_TOOLS, homeDistrict };
