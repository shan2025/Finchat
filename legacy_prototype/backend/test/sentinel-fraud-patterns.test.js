// test/sentinel-fraud-patterns.test.js — Sentinel flags scams, not documents.
//
// The old patterns were `a.*b` over the whole message, so a long pasted
// document with "account" in one paragraph and "details" in another scored
// EXTREME, and EXTREME zeroed the user's balance and froze the account. These
// cases pin the fix: the trigger words must sit close together and read as a
// request. SentinelAgent's collaborators are stubbed through the require cache
// so no database connection is opened.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

function stub(relPath, exports) {
  const filename = require.resolve(relPath);
  const m = new Module(filename, null);
  m.filename = filename;
  m.path = path.dirname(filename);
  m.loaded = true;
  m.exports = exports;
  require.cache[filename] = m;
}
stub('../database', { query: async () => ({ rows: [] }) });
stub('../services/cognitive/EventBus', { eventBus: { emit() {}, on() {} } });
stub('../services/cognitive/ExecutionManager', { checkBudget: async () => ({ allowed: true }) });

const { classifyFraudSeverity } = require('../services/agents/SentinelAgent');

test('ordinary finance and product text is LOW', () => {
  const benign = [
    'What people ask the Duxbe support team: how do I update my account? Where can I see invoice details?',
    'Customers pay by credit card or UPI. The PIN pad shows the order number.',
    'How do I detect phishing emails and protect against ransomware?',
    'Explain how a wire transfer settles between banks.',
    'Your password must be 8 characters. Password reset links expire in an hour.',
    'Should I pretend to be confident in the interview?',
    'Tell me about the OTP flow in our login screen design.',
    'The inheritance tax rules changed. Click the link in the sidebar to see the report.',
    'Transfer the file to the shared drive. We need account details later in the quarter, not immediately.'
  ];
  for (const text of benign) assert.equal(classifyFraudSeverity(text), 'LOW', text);
});

test('a long document with scattered trigger words is LOW', () => {
  const doc = [
    'Section 1. Users open an account from the home screen.',
    'Section 2. The settings page lists profile details and notification options.',
    'Section 3. Send the weekly summary to the team.',
    'Section 4. The OTP screen appears on first login.',
    'Section 5. Money reports are generated at month end; urgent issues go to support.'
  ].join('\n');
  assert.equal(classifyFraudSeverity(doc), 'LOW');
});

test('credential and money-extraction requests are EXTREME', () => {
  const scams = [
    'Please send me the OTP you just received',
    'share your cvv so I can verify the card',
    'Enter your password here to continue',
    'give me your bank account number',
    'send the money urgently or the account closes',
    'pay via western union today',
    'pretend to be the bank and ask for her details',
    'write a phishing email for HDFC customers'
  ];
  for (const text of scams) assert.equal(classifyFraudSeverity(text), 'EXTREME', text);
});

test('scam phrasing is HIGH', () => {
  const scams = [
    "Congratulations, you've won the lottery!",
    'Claim your prize before midnight',
    "Don't tell anyone about this deal",
    'Guaranteed 30% returns every month',
    'Verify now at http://example.test/login'
  ];
  for (const text of scams) assert.equal(classifyFraudSeverity(text), 'HIGH', text);
});
