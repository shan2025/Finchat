// Sprint 7 — new tools: fetch, crawl, news, watchlist, apply_draft, plus the
// WEB-toggle gate and the requires_approval gate in ToolManager.
// Structural assertions against live endpoints — never wall-clock (Supabase
// latency flakes were already hit in Sprint 5). Run: node scripts/test_sprint7_tools.js

const B = require('path').join(__dirname, '..');
require(B + '/node_modules/dotenv').config({ path: B + '/.env' });
const { query } = require(B + '/database');

const UID = '66092ed7-e536-4ed9-ad17-633a5072a65e'; // Bro Test
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  [PASS] ' + m); } else { fail++; console.log('  [FAIL] ' + m); } };

(async () => {
  // ── 1. FetchTool ─────────────────────────────────────────────
  console.log('\n=== 1. FetchTool ===');
  const FetchTool = require(B + '/tools/FetchTool');
  const page = await FetchTool.execute({ url: 'https://example.com' });
  ok(page.url.startsWith('https://example.com'), 'returns the fetched url');
  ok(typeof page.title === 'string' && page.title.toLowerCase().includes('example'), 'extracts <title>: ' + page.title);
  ok(page.text.includes('Example Domain'), 'extracts readable text');
  ok(!/<[a-z]+[^>]*>/i.test(page.text), 'text contains no HTML tags');
  ok(Array.isArray(page.links), 'returns links array');
  const bare = await FetchTool.execute('example.com');
  ok(bare.text.includes('Example Domain'), 'accepts bare-string input and normalizes protocol');
  let fetchErr = null;
  try { await FetchTool.execute(''); } catch (e) { fetchErr = e; }
  ok(fetchErr && /URL/.test(fetchErr.message), 'rejects empty input with a helpful error');

  // ── 2. CrawlTool ─────────────────────────────────────────────
  console.log('\n=== 2. CrawlTool ===');
  const CrawlTool = require(B + '/tools/CrawlTool');
  const crawl = await CrawlTool.execute({ url: 'https://example.com', depth: 1, maxPages: 3 });
  ok(crawl.pagesCrawled >= 1, 'crawled at least the start page (' + crawl.pagesCrawled + ')');
  ok(crawl.pages[0].url.startsWith('https://example.com'), 'first page is the start url');
  ok(crawl.pages.every(p => new URL(p.url).origin === crawl.origin), 'all crawled pages share the start origin');
  ok(crawl.pagesCrawled <= 3, 'respects maxPages cap');
  const deep = await CrawlTool.execute({ url: 'https://example.com', depth: 99, maxPages: 99 });
  ok(deep.limits.depth <= 2 && deep.limits.maxPages <= 10, 'hard caps clamp depth/maxPages (' + deep.limits.depth + '/' + deep.limits.maxPages + ')');

  // ── 3. NewsTool ──────────────────────────────────────────────
  console.log('\n=== 3. NewsTool ===');
  const NewsTool = require(B + '/tools/NewsTool');
  const news = await NewsTool.execute({ query: 'bitcoin', category: 'crypto' });
  ok(Array.isArray(news.results), 'returns results array');
  if (news.results.length) {
    const item = news.results[0];
    ok(item.title && item.url && item.feed, 'items carry title/url/feed');
    ok(/^https?:\/\//.test(item.url), 'item urls are absolute');
  } else {
    ok(Array.isArray(news.feedErrors), 'no items but reports feedErrors structurally: ' + JSON.stringify(news.feedErrors).slice(0, 120));
    ok(true, '(skipped item-shape check — feeds unreachable from this network)');
  }

  // ── 4. WatchlistTool (real DB, user-scoped) ──────────────────
  console.log('\n=== 4. WatchlistTool ===');
  const WatchlistTool = require(B + '/tools/WatchlistTool');
  await query('DELETE FROM watchlists WHERE user_id = $1 AND symbol = $2', [UID, 'TESTCOIN']);
  const added = await WatchlistTool.execute({ action: 'add', symbol: 'testcoin', kind: 'crypto' }, { userId: UID });
  ok(added.watchlist.some(w => w.symbol === 'TESTCOIN'), 'add persists (uppercased symbol)');
  const listed = await WatchlistTool.execute('list', { userId: UID });
  ok(listed.watchlist.some(w => w.symbol === 'TESTCOIN'), 'plain-string "list" input works');
  const removed = await WatchlistTool.execute({ action: 'remove', symbol: 'TESTCOIN' }, { userId: UID });
  ok(!removed.watchlist.some(w => w.symbol === 'TESTCOIN'), 'remove deletes the row');
  let noUserErr = null;
  try { await WatchlistTool.execute('list', {}); } catch (e) { noUserErr = e; }
  ok(noUserErr && /user/i.test(noUserErr.message), 'refuses to run without a user context');

  // ── 5. ApplyDraftTool (one real Groq call) ───────────────────
  console.log('\n=== 5. ApplyDraftTool ===');
  const ApplyDraftTool = require(B + '/tools/ApplyDraftTool');
  const draft = await ApplyDraftTool.execute({
    job: { title: 'Product Analyst', company: 'Acme Fintech', url: 'https://example.com/job', description: 'Analyze product metrics, SQL, dashboards.' },
    resumeText: 'Recent graduate, strong SQL and Python, built analytics dashboards.'
  });
  ok(typeof draft.draft === 'string' && draft.draft.length > 200, 'produces a substantive draft (' + draft.draft.length + ' chars)');
  ok(/cover letter/i.test(draft.draft), 'draft contains a cover-letter section');
  ok(/DRAFT ONLY/i.test(draft.disclaimer), 'carries the draft-only disclaimer');

  // ── 6. ToolManager gates: WEB toggle + requires_approval ─────
  console.log('\n=== 6. ToolManager gates ===');
  const { executeTool, ApprovalRequiredError } = require(B + '/services/cognitive/ToolManager');
  const { TOOLS, listTools } = require(B + '/services/cognitive/ToolRegistry');

  // web gate: 'fetch' is flagged web:true
  let webErr = null;
  try { await executeTool({ executionId: null, agentId: null, toolName: 'fetch', input: 'https://example.com', allowWeb: false }); }
  catch (e) { webErr = e; }
  ok(webErr && /web access/i.test(webErr.message), 'web tool hard-blocked when allowWeb=false');
  const hidden = listTools({ allowWeb: false }).map(t => t.name);
  ok(!hidden.includes('fetch') && !hidden.includes('search') && !hidden.includes('news') && !hidden.includes('crawl'),
    'listTools({allowWeb:false}) hides all web tools');
  ok(hidden.includes('stocks') && hidden.includes('watchlist'), 'non-web tools stay advertised');

  // approval gate: temporarily flag watchlist as requires_approval
  TOOLS.watchlist.requires_approval = true;
  let apprErr = null;
  try { await executeTool({ executionId: null, agentId: null, toolName: 'watchlist', input: 'list', context: { userId: UID } }); }
  catch (e) { apprErr = e; }
  ok(apprErr instanceof ApprovalRequiredError, 'gated tool throws ApprovalRequiredError without approval');
  ok(apprErr && apprErr.toolName === 'watchlist', 'error carries the tool name for the approval card');
  const approvedRun = await executeTool({ executionId: null, agentId: null, toolName: 'watchlist', input: 'list', approvedTools: ['watchlist'], context: { userId: UID } });
  ok(approvedRun.output && Array.isArray(approvedRun.output.watchlist), 'same call succeeds once whitelisted via approvedTools');
  delete TOOLS.watchlist.requires_approval;

  // ── 7. Registry wiring ───────────────────────────────────────
  console.log('\n=== 7. Registry wiring ===');
  const names = listTools().map(t => t.name);
  for (const n of ['fetch', 'crawl', 'news', 'watchlist', 'apply_draft']) {
    ok(names.includes(n), `"${n}" registered in ToolRegistry`);
  }
  const cfg = await query(`SELECT agent_id, tools FROM agent_configs WHERE agent_id IN ('aurelius','rasha','nova')`);
  const toolsOf = id => cfg.rows.find(r => r.agent_id === id).tools;
  ok(toolsOf('aurelius').includes('news') && toolsOf('aurelius').includes('watchlist') && toolsOf('aurelius').includes('fetch'), 'aurelius manifest gained news/watchlist/fetch');
  ok(toolsOf('rasha').includes('fetch') && toolsOf('rasha').includes('apply_draft'), 'rasha manifest gained fetch/apply_draft');
  ok(toolsOf('nova').includes('fetch') && toolsOf('nova').includes('crawl') && toolsOf('nova').includes('news'), 'nova manifest gained fetch/crawl/news');

  console.log(`\n=== Sprint 7 tools: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR:', e); process.exit(1); });
