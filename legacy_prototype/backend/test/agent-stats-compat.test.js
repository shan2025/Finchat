// test/agent-stats-compat.test.js — a page open across a deploy must not print "undefined%".
//
// On 2026-11-15 the Agent Map's "accuracy" became "finished" / "useful". A tab
// loaded before the deploy kept its old script, asked the new server for
// profiles, read cell.accuracy, and filled every cell with "undefined%". Two
// guards, both pinned here:
//   1. the server keeps sending `accuracy` with its ORIGINAL meaning (finished),
//   2. the new page never concatenates a raw number with "%" — it goes through
//      pct(), which shows "—" for a missing value.
// The database is stubbed through require.cache; nothing here opens a pool.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const dbPath = require.resolve('../database');
const m = new Module(dbPath, null);
m.filename = dbPath; m.loaded = true;
m.exports = {
  query: async (sql) => {
    if (/WITH lanes/.test(sql)) return { rows: [] };
    if (/GROUP BY e\.assigned_agent/.test(sql)) {
      return { rows: [{ agent: 'aurelius', runs: 4, races: 0, natural_count: 3, error_count: 1, rated: 2, rated_up: 1, avg_tokens: 1000, avg_tools: 1, avg_secs: 5 }] };
    }
    // profiles
    return { rows: [
      { agent: 'aurelius', goal: 'latest BTC price', tokens_used: 1000, completion_reason: 'natural', rating: '1', secs: 5 },
      { agent: 'aurelius', goal: 'ETH stock price', tokens_used: 1000, completion_reason: 'natural', rating: '-1', secs: 5 },
      { agent: 'aurelius', goal: 'nifty price today', tokens_used: 1000, completion_reason: 'natural', rating: null, secs: 5 },
      { agent: 'aurelius', goal: 'gold price', tokens_used: 1000, completion_reason: 'error', rating: null, secs: 5 }
    ] };
  }
};
require.cache[dbPath] = m;
const { getLeaderboard, getAgentProfiles } = require('../services/AgentLeaderboard');

describe('legacy `accuracy` field', () => {
  test('leaderboard rows still carry it, meaning finished', async () => {
    const [row] = await getLeaderboard({});
    assert.equal(row.finished, 75);
    assert.equal(row.accuracy, row.finished, 'old pages read row.accuracy');
    assert.equal(typeof row.useful, 'number');
  });

  test('profile cells and best-per-task carry it too', async () => {
    const prof = await getAgentProfiles({});
    const cell = prof.agents[0].cells.markets;
    assert.equal(cell.finished, 75);
    assert.equal(cell.accuracy, cell.finished, 'old pages read cell.accuracy');
    assert.equal(prof.bestPerTask.markets.accuracy, cell.finished, 'old pages read best.accuracy');
  });
});

describe('the new page never prints "undefined%"', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'finchat_agentmap.html'), 'utf8');

  test('a pct() helper exists and dashes missing values', () => {
    const src = html.match(/function pct\(v\) \{[^\n]*\}/);
    assert.ok(src, 'pct helper is defined');
    const pct = new Function(src[0] + '; return pct;')();
    assert.equal(pct(42), '42%');
    assert.equal(pct(0), '0%');
    for (const v of [undefined, null, '', 'abc', NaN]) assert.equal(pct(v), '—', String(v));
  });

  test('no stats field is glued to "%" directly', () => {
    for (const f of ['useful', 'finished', 'helpful', 'accuracy']) {
      assert.ok(!new RegExp(`\\.${f} \\+ '%`).test(html), `.${f} + '%' bypasses pct()`);
    }
  });
});
