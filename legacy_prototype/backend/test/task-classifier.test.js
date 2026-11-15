// test/task-classifier.test.js — the label every Agent Map statistic is bucketed by.
//
// The old classifier was six regexes where the first match won, with no bucket
// for careers, learning or system questions. These are real-shaped goals and
// the label each one must get; a lexicon change that breaks one of them shifts
// history between buckets, so it should fail here first.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classifyTask, scoreTasks, TASK_TYPES } = require('../services/cognitive/taskClassifier');
const leaderboard = require('../services/AgentLeaderboard');

const CASES = [
  // markets
  ['what about jensen huang controversy ? did it effect the stocks ?', 'markets'],
  ["What's the latest BTC price?", 'markets'],
  ['Is ETH bullish or bearish this week?', 'markets'],
  ['how did nifty close today', 'markets'],
  ['upcoming IPOs in India', 'markets'],
  ['USD to INR exchange rate', 'markets'],
  // portfolio
  ['how am I doing on my investments', 'portfolio'],
  ['review my portfolio', 'portfolio'],
  ['how risky is my portfolio', 'portfolio'],
  ['add SOL to my watchlist', 'portfolio'],
  // risk
  ["what's the drawdown and volatility on ADA", 'risk'],
  // news
  ['latest news on the RBI digital rupee', 'news'],
  ['What are the latest trends in FinTech in India?', 'news'],
  // research
  ['find recent papers on neuromorphic computing', 'research'],
  ['deep dive into transformer architecture research', 'research'],
  // learning
  ['explain drawdown in simple terms', 'learning'],
  ['teach me how looped transformers work', 'learning'],
  ['what is a Sharpe ratio, explain like I am five', 'learning'],
  // careers
  ['find product manager jobs in Bangalore', 'careers'],
  ['tailor my resume for this posting', 'careers'],
  ['what salary should I expect for a data analyst role', 'careers'],
  ['AI applications in fintech research papers', 'research'],
  // compliance
  ['what does SEBI regulation say about investment advisers', 'compliance'],
  // system
  ['is Atlas working?', 'system'],
  ["why didn't Nova reply, is something broken", 'system'],
  // general
  ['hello', 'general'],
  ['write me a haiku about rain', 'general']
];

describe('classifyTask', () => {
  for (const [goal, want] of CASES) {
    test(`"${goal}" → ${want}`, () => {
      const { task, scores, matched } = scoreTasks(goal);
      assert.equal(task, want, `scored ${JSON.stringify(scores)} matched ${JSON.stringify(matched)}`);
    });
  }

  test('a price is not automatically markets (the old first-match bug)', () => {
    assert.equal(classifyTask('salary price expectations for an analyst job'), 'careers');
  });

  test('"what is" alone no longer makes everything research', () => {
    assert.notEqual(classifyTask('what is the latest bitcoin price'), 'research');
  });

  test('every label it can return is a declared task type', () => {
    for (const [goal] of CASES) assert.ok(TASK_TYPES.includes(classifyTask(goal)));
  });

  test('empty and odd input are general, never a throw', () => {
    for (const g of [undefined, null, '', 42, {}]) assert.equal(classifyTask(g), 'general');
  });

  test('AgentLeaderboard exposes the same classifier (one taxonomy everywhere)', () => {
    assert.equal(leaderboard.classifyTask, classifyTask);
    assert.deepEqual(leaderboard.TASK_TYPES, TASK_TYPES);
  });
});
