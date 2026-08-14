// test/whatsapp.test.js — the WhatsApp channel's rules, not its plumbing.
//
// The send paths run against a local stub standing in for Twilio and Meta, so
// the two behaviours that decide whether a briefing arrives — splitting a long
// report into accepted chunks, and falling back to a template when the
// 24-hour window has closed — are asserted on the requests actually sent
// rather than inferred from the code.
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

const wa = require('../services/whatsapp');

// ── Provider stub ────────────────────────────────────────────
let server, baseUrl;
let received = [];      // every request body the stub saw
let nextFailure = null; // { provider, code } — makes the next send fail

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(raw));
  });
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    const isTwilio = req.url.includes('/Messages.json');
    const body = isTwilio
      ? Object.fromEntries(new URLSearchParams(raw))
      : JSON.parse(raw || '{}');
    received.push({ provider: isTwilio ? 'twilio' : 'meta', url: req.url, body });

    if (nextFailure && nextFailure.provider === (isTwilio ? 'twilio' : 'meta')) {
      const code = nextFailure.code;
      nextFailure = null;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(isTwilio
        ? JSON.stringify({ code, message: 'stub failure' })
        : JSON.stringify({ error: { code: 131000, error_subcode: code, message: 'stub failure' } }));
    }
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sid: 'SMstub', messages: [{ id: 'wamid.stub' }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  received = [];
  nextFailure = null;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('WHATSAPP_') || k.startsWith('TWILIO_')) delete process.env[k];
  }
});

function useTwilio() {
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'tok-test';
  process.env.TWILIO_WHATSAPP_FROM = '+14155238886';
  process.env.TWILIO_API_BASE = baseUrl;
}

function useMeta() {
  process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890';
  process.env.WHATSAPP_ACCESS_TOKEN = 'meta-token';
  process.env.WHATSAPP_GRAPH_BASE = baseUrl;
}

// ── Phone numbers ────────────────────────────────────────────
describe('normalizeE164', () => {
  test('accepts numbers written the way people write them', () => {
    assert.equal(wa.normalizeE164('+91 98765 43210').e164, '+919876543210');
    assert.equal(wa.normalizeE164('+1 (415) 555-0100').e164, '+14155550100');
    assert.equal(wa.normalizeE164('0044 7700 900123').e164, '+447700900123');
  });

  test('refuses to guess a missing country code', () => {
    // Prefixing the wrong one delivers a private briefing to a stranger.
    const r = wa.normalizeE164('9876543210');
    assert.equal(r.e164, null);
    assert.match(r.error, /country code/);
  });

  test('fills the country code in only when the deployment opts in', () => {
    process.env.WHATSAPP_DEFAULT_COUNTRY = '91';
    assert.equal(wa.normalizeE164('9876543210').e164, '+919876543210');
    // Already carrying the code — must not be doubled.
    assert.equal(wa.normalizeE164('919876543210').e164, '+919876543210');
  });

  test('rejects lengths outside E.164', () => {
    assert.equal(wa.normalizeE164('+123').e164, null);
    assert.equal(wa.normalizeE164('+1234567890123456789').e164, null);
    assert.equal(wa.normalizeE164('').e164, null);
  });
});

// ── Splitting ────────────────────────────────────────────────
describe('splitForWhatsApp', () => {
  const long = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n');

  test('every chunk stays under the provider limit, counter included', () => {
    for (const max of [1500, 3900]) {
      const parts = wa.splitForWhatsApp(long, max);
      assert.ok(parts.length > 1, 'should have split');
      for (const p of parts) assert.ok(p.length <= max, `chunk of ${p.length} exceeds ${max}`);
    }
  });

  test('short text is passed through unchanged and uncounted', () => {
    assert.deepEqual(wa.splitForWhatsApp('hi there', 1500), ['hi there']);
  });

  test('parts are numbered — WhatsApp does not guarantee ordering', () => {
    const parts = wa.splitForWhatsApp(long, 1500);
    assert.ok(parts[0].startsWith(`(1/${parts.length})`));
  });

  test('no content is lost across the split', () => {
    const parts = wa.splitForWhatsApp(long, 1500);
    const rejoined = parts.map(p => p.replace(/^\(\d+\/\d+\)\n/, '')).join('\n');
    assert.equal(rejoined, long);
  });
});

// ── Inbound parsing ──────────────────────────────────────────
describe('parseInbound', () => {
  test('reads a Twilio form post', () => {
    const got = wa.parseInbound({ From: 'whatsapp:+14155550100', Body: 'hello' });
    assert.deepEqual(got, [{ from: '+14155550100', text: 'hello', provider: 'twilio' }]);
  });

  test('reads a Meta batch, restoring the plus Meta omits', () => {
    const got = wa.parseInbound({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [{ from: '919876543210', type: 'text', text: { body: 'hi' } }] } }] }]
    });
    assert.deepEqual(got, [{ from: '+919876543210', text: 'hi', provider: 'meta' }]);
  });

  test('ignores Meta delivery receipts', () => {
    // These arrive constantly and share the envelope shape. Treating one as
    // inbound would reopen the 24-hour window without the user saying anything.
    const got = wa.parseInbound({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { statuses: [{ status: 'delivered', recipient_id: '919876543210' }] } }] }]
    });
    assert.deepEqual(got, []);
  });

  test('survives junk', () => {
    for (const junk of [null, undefined, {}, { entry: 'nope' }, []]) {
      assert.deepEqual(wa.parseInbound(junk), []);
    }
  });
});

// ── Link codes ───────────────────────────────────────────────
describe('link codes', () => {
  test('codes are a fixed width so the inbound matcher can find them', () => {
    // Math.random().toString(36).slice(2,8) yields fewer than 6 chars often
    // enough to break linking at random; the code must not depend on it.
    const codes = Array.from({ length: 500 }, () => wa.mintLinkCode('u1'));
    assert.deepEqual([...new Set(codes.map(c => c.length))], [8]);
    assert.equal(new Set(codes).size, codes.length, 'codes should not collide');
  });

  test('round-trips out of a real message body', () => {
    const code = wa.mintLinkCode('user-42');
    assert.equal(wa.extractLinkCode(`Hi! FinChat link ${code} thanks`), code);
    assert.equal(wa.peekLinkCode(code).userId, 'user-42');
    wa.consumeLinkCode(code);
    assert.equal(wa.peekLinkCode(code), null);
  });

  test('finds nothing in ordinary messages', () => {
    assert.equal(wa.extractLinkCode('hello there'), null);
    assert.equal(wa.extractLinkCode('join fresh-owl'), null);
    assert.equal(wa.extractLinkCode(''), null);
  });
});

// ── The 24-hour window ───────────────────────────────────────
describe('windowState', () => {
  test('never contacted → closed', () => {
    assert.equal(wa.windowState({}).open, false);
    assert.equal(wa.windowState({ whatsapp_last_inbound_at: null }).open, false);
  });

  test('recent inbound → open with time remaining', () => {
    const oneHourAgo = new Date(Date.now() - 3600e3).toISOString();
    const s = wa.windowState({ whatsapp_last_inbound_at: oneHourAgo });
    assert.equal(s.open, true);
    assert.ok(s.minutesLeft > 22 * 60 && s.minutesLeft <= 23 * 60, `got ${s.minutesLeft}`);
  });

  test('25 hours ago → closed', () => {
    const s = wa.windowState({ whatsapp_last_inbound_at: new Date(Date.now() - 25 * 3600e3).toISOString() });
    assert.equal(s.open, false);
    assert.equal(s.minutesLeft, 0);
  });

  test('an unparseable timestamp is treated as closed, not as open', () => {
    assert.equal(wa.windowState({ whatsapp_last_inbound_at: 'not a date' }).open, false);
  });
});

// ── Sending ──────────────────────────────────────────────────
describe('sendText', () => {
  test('reports unconfigured rather than throwing', async () => {
    const r = await wa.sendText('+14155550100', 'hi');
    assert.equal(r.status, 'unconfigured');
    assert.match(r.detail, /TWILIO_ACCOUNT_SID|WHATSAPP_PHONE_NUMBER_ID/);
  });

  test('Twilio: sends whatsapp: addresses on both ends', async () => {
    useTwilio();
    const r = await wa.sendText('+91 98765 43210', 'hello');
    assert.equal(r.status, 'sent');
    assert.equal(received.length, 1);
    assert.equal(received[0].body.To, 'whatsapp:+919876543210');
    assert.equal(received[0].body.From, 'whatsapp:+14155238886');
    assert.equal(received[0].body.Body, 'hello');
  });

  test('Meta: sends bare digits and the messaging_product marker', async () => {
    useMeta();
    const r = await wa.sendText('+91 98765 43210', 'hello');
    assert.equal(r.status, 'sent');
    assert.equal(received[0].body.to, '919876543210');
    assert.equal(received[0].body.messaging_product, 'whatsapp');
    assert.equal(received[0].body.text.body, 'hello');
  });

  test('a long report becomes several accepted requests', async () => {
    useTwilio();
    const long = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n');
    const r = await wa.sendText('+14155550100', long);
    assert.equal(r.status, 'sent');
    assert.ok(received.length > 1, 'should have sent multiple parts');
    for (const req of received) assert.ok(req.body.Body.length <= 1500);
  });

  test('a bad number fails locally, without calling the provider', async () => {
    useTwilio();
    const r = await wa.sendText('98765', 'hi');
    assert.equal(r.status, 'failed');
    assert.equal(received.length, 0);
  });

  test('provider error codes become sentences, and flag the window', async () => {
    useTwilio();
    nextFailure = { provider: 'twilio', code: 63016 };
    const r = await wa.sendText('+14155550100', 'hi');
    assert.equal(r.status, 'failed');
    assert.equal(r.windowClosed, true);
    assert.match(r.detail, /24-hour window/);

    useMeta();
    nextFailure = { provider: 'meta', code: 131047 };
    const m = await wa.sendText('+14155550100', 'hi');
    assert.equal(m.windowClosed, true);
    assert.match(m.detail, /24-hour window/);
  });

  test('an unknown code still surfaces the provider message', async () => {
    useTwilio();
    nextFailure = { provider: 'twilio', code: 99999 };
    const r = await wa.sendText('+14155550100', 'hi');
    assert.equal(r.status, 'failed');
    assert.equal(r.windowClosed, false);
    assert.match(r.detail, /99999/);
  });
});

// ── Window-aware dispatch ────────────────────────────────────
describe('sendNotification', () => {
  const prefs = (lastInbound) => ({ whatsapp_to: '+14155550100', whatsapp_last_inbound_at: lastInbound });

  test('inside the window it sends freeform', async () => {
    useTwilio();
    const r = await wa.sendNotification(prefs(new Date().toISOString()), {
      title: 'Morning briefing', body: 'Markets are up.', summary: 'Markets are up.'
    });
    assert.equal(r.status, 'sent');
    assert.match(received[0].body.Body, /Morning briefing/);
    assert.equal(received[0].body.ContentSid, undefined);
  });

  test('outside the window with a template configured, it sends the template', async () => {
    useTwilio();
    process.env.TWILIO_CONTENT_SID = 'HXtemplate';
    const r = await wa.sendNotification(prefs(new Date(Date.now() - 30 * 3600e3).toISOString()), {
      title: 'Morning briefing', body: 'Markets are up.', summary: 'Markets are up.'
    });
    assert.equal(r.status, 'sent');
    assert.equal(received.length, 1, 'should not waste a doomed freeform send');
    assert.equal(received[0].body.ContentSid, 'HXtemplate');
    assert.equal(JSON.parse(received[0].body.ContentVariables)['1'], 'Markets are up.');
  });

  test('outside the window with no template, it explains instead of failing silently', async () => {
    useTwilio();
    const r = await wa.sendNotification(prefs(new Date(Date.now() - 30 * 3600e3).toISOString()), {
      title: 'Morning briefing', body: 'Markets are up.', summary: 'Markets are up.'
    });
    assert.equal(r.status, 'skipped');
    assert.match(r.detail, /template/);
    assert.match(r.detail, /Reopen it by sending/);
  });

  test('when our clock is wrong, the provider wins and the template goes out', async () => {
    // We believe the window is open; Twilio says 63016. Without the fallback
    // this is the case where a briefing silently never arrives.
    useTwilio();
    process.env.TWILIO_CONTENT_SID = 'HXtemplate';
    nextFailure = { provider: 'twilio', code: 63016 };
    const r = await wa.sendNotification(prefs(new Date().toISOString()), {
      title: 'Morning briefing', body: 'Markets are up.', summary: 'Markets are up.'
    });
    assert.equal(r.status, 'sent');
    assert.equal(received.length, 2, 'freeform attempt, then template');
    assert.equal(received[1].body.ContentSid, 'HXtemplate');
  });

  test('a never-contacted number still gets one freeform attempt', async () => {
    // Deployments without a public webhook never learn about inbound messages,
    // so "no record" must not mean "never send".
    useTwilio();
    const r = await wa.sendNotification(prefs(null), {
      title: 'Alert', body: 'Something happened.', summary: 'Something happened.'
    });
    assert.equal(r.status, 'sent');
    assert.match(received[0].body.Body, /Alert/);
  });

  test('template parameters are flattened — WhatsApp rejects newlines in them', async () => {
    useMeta();
    process.env.WHATSAPP_TEMPLATE_NAME = 'finchat_alert';
    const r = await wa.sendNotification(prefs(new Date(Date.now() - 30 * 3600e3).toISOString()), {
      title: 'Briefing', body: 'x', summary: 'line one\nline two\tand more'
    });
    assert.equal(r.status, 'sent');
    const param = received[0].body.template.components[0].parameters[0].text;
    assert.equal(param, 'line one line two and more');
    assert.equal(received[0].body.template.name, 'finchat_alert');
  });
});

// ── Webhook authenticity ─────────────────────────────────────
describe('signature verification', () => {
  test('Twilio: accepts its own signature, rejects a tampered one', () => {
    process.env.TWILIO_AUTH_TOKEN = 'tok-test';
    const url = 'https://finchat.example/api/whatsapp/webhook';
    const params = { From: 'whatsapp:+14155550100', Body: 'hi' };
    // Twilio's scheme: HMAC-SHA1 over the URL plus params sorted by key.
    const data = url + 'Body' + params.Body + 'From' + params.From;
    const sig = crypto.createHmac('sha1', 'tok-test').update(Buffer.from(data, 'utf-8')).digest('base64');

    assert.equal(wa.verifyTwilioSignature(sig, url, params), true);
    assert.equal(wa.verifyTwilioSignature(sig, url, { ...params, Body: 'tampered' }), false);
    assert.equal(wa.verifyTwilioSignature('nonsense', url, params), false);
    assert.equal(wa.verifyTwilioSignature('', url, params), false);
  });

  test('Meta: accepts its own signature over the raw bytes', () => {
    process.env.WHATSAPP_APP_SECRET = 'app-secret';
    const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account' }));
    const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex');

    assert.equal(wa.verifyMetaSignature(sig, raw), true);
    assert.equal(wa.verifyMetaSignature(sig, Buffer.from('{}')), false);
    assert.equal(wa.verifyMetaSignature('sha256=deadbeef', raw), false);
  });

  test('no secret configured means no signature is ever accepted', () => {
    assert.equal(wa.verifyTwilioSignature('anything', 'https://x', {}), false);
    assert.equal(wa.verifyMetaSignature('sha256=anything', Buffer.from('{}')), false);
  });
});

// ── Provider selection ───────────────────────────────────────
describe('activeProvider', () => {
  test('null when nothing is configured', () => {
    assert.equal(wa.activeProvider(), null);
    assert.equal(wa.configStatus().configured, false);
  });

  test('prefers the permanent Meta sender over the Twilio sandbox', () => {
    useTwilio(); useMeta();
    assert.equal(wa.activeProvider(), 'meta');
  });

  test('WHATSAPP_PROVIDER forces the choice', () => {
    useTwilio(); useMeta();
    process.env.WHATSAPP_PROVIDER = 'twilio';
    assert.equal(wa.activeProvider(), 'twilio');
  });

  test('forcing a provider with no credentials reports why, not a silent fallback', () => {
    useTwilio();
    process.env.WHATSAPP_PROVIDER = 'meta';
    assert.equal(wa.activeProvider(), null);
    assert.match(wa.configStatus().detail, /WHATSAPP_PROVIDER=meta/);
  });
});
