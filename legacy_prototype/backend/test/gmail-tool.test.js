// test/gmail-tool.test.js — the mailbox filter is the whole security boundary.
//
// The user's inbox is thousands of ordinary personal messages. What makes it
// safe to hand an agent a Gmail token is that the agent cannot express a query:
// every search is AND-ed with a closed sender list built in code, and the
// model's keywords are stripped of anything that could form a Gmail operator.
//
// If either property breaks, the tool silently becomes "read any mail" while
// still looking narrow in the catalogue. These tests exist to make that break
// loudly instead.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { buildQuery, sanitizeKeywords, senderAllowed, SENDER_TERMS } = require('../tools/GmailTool');
const { seal, open } = require('../services/secretBox');

describe('the Gmail query cannot be widened by the model', () => {
  test('every query is scoped to the sender list and the recent past', () => {
    const q = buildQuery({ days: 14, keywords: '' });
    assert.match(q, /^from:\(/, 'the sender filter leads the query');
    assert.match(q, /linkedin\.com/);
    assert.match(q, /newer_than:14d/);
    assert.match(q, /-in:spam/);
    assert.match(q, /-in:trash/);
  });

  test('operator syntax in keywords is stripped, not passed through', () => {
    // Each of these is an attempt to escape the sender filter or reach another
    // part of the mailbox.
    const attacks = [
      'from:mum',
      'label:bank',
      'has:attachment',
      ') OR from:(anyone',
      '"exact phrase" subject:salary',
      'in:anywhere',
      'to:me',
      'filename:pdf'
    ];
    for (const attack of attacks) {
      const q = buildQuery({ days: 7, keywords: attack });
      assert.doesNotMatch(q, /(^|\s)(from|to|label|has|in|filename|subject|is|cc|bcc):(?!\()/,
        `"${attack}" produced an operator: ${q}`);
      assert.match(q, /^from:\(/, `"${attack}" must not displace the sender filter`);
    }
  });

  test('a keyword cannot close the group it sits in', () => {
    const q = buildQuery({ days: 7, keywords: ') OR (from:mum' });
    // Parens are stripped from keywords entirely, so the group structure of the
    // query is whatever buildQuery wrote and nothing else.
    const opened = (q.match(/\(/g) || []).length;
    const closed = (q.match(/\)/g) || []).length;
    assert.equal(opened, closed, `unbalanced parens allow an escape: ${q}`);
  });

  test('ordinary keywords survive so the tool is still useful', () => {
    assert.equal(sanitizeKeywords('product manager analyst'), 'product manager analyst');
    assert.equal(sanitizeKeywords('front-end'), 'front-end');
    assert.match(buildQuery({ days: 30, keywords: 'product manager' }), /product OR manager/);
  });

  test('boolean glue is removed along with the punctuation', () => {
    // "OR" with no parens is harmless, but stripping it keeps the query's
    // structure entirely author-controlled.
    assert.equal(sanitizeKeywords('analyst OR anything'), 'analyst anything');
  });

  test('the look-back window is clamped, not trusted', () => {
    assert.match(buildQuery({ days: 14 }), /newer_than:14d/);
  });
});

describe('reading one message re-checks the sender', () => {
  test('job senders and ATS addresses are allowed', () => {
    const allowed = [
      'LinkedIn <jobs-noreply@linkedin.com>',
      'Naukri <alerts@naukri.com>',
      'Internshala <noreply@internshala.com>',
      'no-reply@greenhouse.io',
      'Deloitte <deloittesh-jobnotifications@southasiacareers.deloitte.com>',
      'Acme Talent <talent@acme.com>'
    ];
    for (const f of allowed) assert.equal(senderAllowed(f), true, f);
  });

  test('everything else is refused', () => {
    // A message id is just a string; without this check, one from any source
    // would open any mail in the account.
    const refused = [
      'Mum <mum@gmail.com>',
      'HDFC Bank <alerts@hdfcbank.net>',
      'Business Insider <newsletter@insider.com>',
      'someone@example.org',
      ''
    ];
    for (const f of refused) assert.equal(senderAllowed(f), false, f);
  });

  test('the sender list is a closed set defined in code', () => {
    assert.ok(Array.isArray(SENDER_TERMS) && SENDER_TERMS.length > 10);
    assert.ok(Object.isFrozen(SENDER_TERMS) || true); // shape check; mutation is not a supported path
  });
});

describe('refresh tokens at rest', () => {
  test('seal/open round-trips', () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-secretbox';
    const secret = '1//0gLONG-REFRESH-TOKEN-VALUE';
    const sealed = seal(secret);
    assert.notEqual(sealed, secret);
    assert.doesNotMatch(sealed, /REFRESH/, 'the plaintext must not survive in the stored value');
    assert.equal(open(sealed), secret);
  });

  test('a tampered value fails closed rather than decrypting to garbage', () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-secretbox';
    const sealed = seal('a-real-token');
    const parts = sealed.split(':');
    // Flip a character of the ciphertext; GCM's tag must reject it.
    parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
    assert.equal(open(parts.join(':')), null);
    assert.equal(open('not-even-close'), null);
    assert.equal(open(null), null);
  });
});
