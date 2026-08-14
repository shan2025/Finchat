// services/whatsapp.js — WhatsApp delivery, for real this time.
//
// Two providers are supported because the two free ways to get a WhatsApp
// sender are not interchangeable:
//
//   twilio — Twilio's WhatsApp sandbox. Instant, but the recipient must first
//            enrol by sending "join <phrase>" to Twilio's shared number.
//   meta   — Meta's WhatsApp Cloud API. Free tier, permanent, but a test
//            number only reaches numbers you add to its allow-list.
//
// The provider is chosen by which credentials exist in .env (WHATSAPP_PROVIDER
// forces one when both are present). Everything above this module — the
// channel fan-out, the settings page — talks to sendText/sendTemplate and
// never learns which one is in play.
//
// The 24-hour window is the thing that makes WhatsApp different from every
// other channel here, and it is handled explicitly rather than discovered as a
// delivery failure. See migration 027 for why.
const crypto = require('crypto');
const axios = require('axios');

function graphVersion() { return process.env.WHATSAPP_API_VERSION || 'v21.0'; }

// Test seam. The 24-hour-window fallback and the multi-part split are only
// observable in the requests we actually put on the wire, so the suite points
// these at a local stub. Read per call, like every other setting here, so a
// test can set them after requiring the module. Never set in production.
function twilioBase() { return process.env.TWILIO_API_BASE || 'https://api.twilio.com'; }
function graphBase() { return process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com'; }

// Twilio caps a single WhatsApp body at 1600 characters; WhatsApp itself
// allows 4096. Split below each ceiling rather than at it so the "(1/3)"
// counters we append cannot push a chunk over.
const TWILIO_MAX = 1500;
const META_MAX = 3900;

// ── Provider selection ───────────────────────────────────────
function twilioConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_FROM);
}

function metaConfigured() {
  return Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID &&
    process.env.WHATSAPP_ACCESS_TOKEN);
}

/**
 * @returns {'twilio'|'meta'|null} the provider that will actually be used.
 */
function activeProvider() {
  const forced = (process.env.WHATSAPP_PROVIDER || '').trim().toLowerCase();
  if (forced === 'twilio') return twilioConfigured() ? 'twilio' : null;
  if (forced === 'meta') return metaConfigured() ? 'meta' : null;
  if (metaConfigured()) return 'meta';   // permanent sender beats the sandbox
  if (twilioConfigured()) return 'twilio';
  return null;
}

/**
 * What the Settings page needs to explain the channel's state to the user:
 * whether it can send at all, who the sender is, and how a user links to it.
 */
function configStatus() {
  const provider = activeProvider();
  const joinPhrase = (process.env.TWILIO_WHATSAPP_JOIN_CODE || '').trim();
  return {
    configured: Boolean(provider),
    provider,
    // The number the user messages to open their window. For Twilio's sandbox
    // this is the shared sandbox number, for Meta it is your test/business one.
    senderNumber: provider === 'twilio'
      ? normalizeE164(process.env.TWILIO_WHATSAPP_FROM || '').e164
      : normalizeE164(process.env.WHATSAPP_SENDER_NUMBER || '').e164,
    // Sandbox enrolment phrase, e.g. "join purple-tiger". Twilio shows it in
    // the console; without it we cannot build a working join deep link.
    joinPhrase: provider === 'twilio' ? (joinPhrase || null) : null,
    // Set when business-initiated (outside-window) sends are possible.
    templateName: templateConfig().name || null,
    detail: describeMissing(provider)
  };
}

function describeMissing(provider) {
  if (provider) return null;
  const forced = (process.env.WHATSAPP_PROVIDER || '').trim().toLowerCase();
  if (forced === 'meta') return 'WHATSAPP_PROVIDER=meta but WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN are not set in .env';
  if (forced === 'twilio') return 'WHATSAPP_PROVIDER=twilio but TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM are not set in .env';
  return 'No WhatsApp sender configured — set either TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM, or WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN, in .env';
}

function templateConfig() {
  return {
    name: (process.env.WHATSAPP_TEMPLATE_NAME || '').trim(),
    language: (process.env.WHATSAPP_TEMPLATE_LANG || 'en_US').trim(),
    // Twilio addresses approved templates by Content SID, not by name.
    contentSid: (process.env.TWILIO_CONTENT_SID || '').trim()
  };
}

// ── Phone numbers ────────────────────────────────────────────
/**
 * WhatsApp addresses are E.164 and nothing else — "+91 98765 43210" and
 * "(415) 555-0100" are both rejected by the providers with an unhelpful
 * "invalid To". Normalise here so the user can type a number the way they
 * would write it down.
 *
 * A number with no country code is *not* guessed: prefixing the wrong one
 * delivers someone else's briefing to a stranger. WHATSAPP_DEFAULT_COUNTRY
 * (e.g. "91") opts into filling it in for single-country deployments.
 *
 * @returns {{e164: string|null, digits: string|null, error: string|null}}
 */
function normalizeE164(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { e164: null, digits: null, error: 'No number given' };

  const hadPlus = s.startsWith('+') || s.startsWith('00');
  let digits = s.replace(/\D/g, '');
  if (s.startsWith('00')) digits = digits.slice(2);

  if (!digits) return { e164: null, digits: null, error: 'That does not contain any digits' };

  if (!hadPlus) {
    const cc = (process.env.WHATSAPP_DEFAULT_COUNTRY || '').replace(/\D/g, '');
    if (cc && !digits.startsWith(cc)) {
      digits = cc + digits;
    } else if (!cc) {
      return {
        e164: null,
        digits: null,
        error: 'Include the country code, starting with "+" (e.g. +91 98765 43210)'
      };
    }
  }

  // E.164 allows at most 15 digits; the shortest usable international numbers
  // are around 8. Anything outside that is a typo, and the providers bill for
  // finding that out.
  if (digits.length < 8 || digits.length > 15) {
    return { e164: null, digits: null, error: `"${s}" is not a valid international number (${digits.length} digits)` };
  }
  return { e164: '+' + digits, digits, error: null };
}

// ── Message splitting ────────────────────────────────────────
// Agent reports run well past any single-message limit. Break on newlines so
// each part is a whole section, and number the parts — WhatsApp does not
// guarantee ordering between rapid sends, so an unlabelled split report can
// arrive scrambled with no way for the reader to tell.
function splitForWhatsApp(text, max) {
  const out = [];
  let s = String(text);
  // Leave room for the "(nn/nn)\n" counter added below — adding it afterwards
  // to chunks already sized at `max` is what pushes them over the provider's
  // limit and gets the whole message rejected.
  const COUNTER_ROOM = 10;
  if (s.length > max) max -= COUNTER_ROOM;
  while (s.length > max) {
    let cut = s.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max; // no sensible break — hard cut
    out.push(s.slice(0, cut));
    s = s.slice(cut).replace(/^\n/, '');
  }
  if (s.length) out.push(s);
  if (out.length <= 1) return out;
  return out.map((part, i) => `(${i + 1}/${out.length})\n${part}`);
}

// ── Provider errors ──────────────────────────────────────────
// Both providers report the interesting failures as numeric codes buried in a
// response body. Surfacing "Request failed with status code 400" in the
// delivery log tells the user nothing they can act on, so translate.
const TWILIO_ERRORS = {
  63016: { window: true, msg: 'Outside the 24-hour window — WhatsApp only allows freeform messages within 24h of your last message to the bot. Send the bot any message to reopen it, or configure a template.' },
  63015: { msg: 'Twilio could not reach this number on WhatsApp — check the number has WhatsApp installed.' },
  63007: { msg: 'TWILIO_WHATSAPP_FROM is not a valid WhatsApp sender on this Twilio account.' },
  63018: { msg: 'Rate limited by WhatsApp — too many messages to this number.' },
  63024: { msg: 'WhatsApp rejected the message body.' },
  21211: { msg: 'Twilio rejected the destination number as invalid.' },
  21608: { msg: 'This Twilio account is a trial — the destination number must be verified in the Twilio console first.' },
  21610: { msg: 'This number unsubscribed from your Twilio sender.' },
  63032: { msg: 'The recipient has not joined the WhatsApp sandbox — send "join <phrase>" to the sandbox number first.' }
};

const META_ERRORS = {
  131047: { window: true, msg: 'Outside the 24-hour window — WhatsApp only allows freeform messages within 24h of your last message to the business. Send the number any message to reopen it, or configure a template.' },
  131026: { msg: 'WhatsApp could not deliver to this number — it may not have WhatsApp, or it cannot receive from this sender.' },
  131030: { msg: 'This number is not on the test number\'s allow-list — add it under API Setup in the Meta dashboard (max 5).' },
  131051: { msg: 'Unsupported message type.' },
  132000: { msg: 'The template exists but its parameter count does not match what we sent.' },
  132001: { msg: 'Template not found — check WHATSAPP_TEMPLATE_NAME and WHATSAPP_TEMPLATE_LANG against the Meta dashboard.' },
  190: { msg: 'WHATSAPP_ACCESS_TOKEN has expired or been revoked — generate a new one.' },
  100: { msg: 'Meta rejected the request — check WHATSAPP_PHONE_NUMBER_ID.' },
  133010: { msg: 'The sender phone number is not registered with the Cloud API.' }
};

/**
 * @returns {{message: string, code: number|null, windowClosed: boolean}}
 */
function explainError(err, provider) {
  const data = err && err.response && err.response.data;
  if (provider === 'twilio' && data && data.code) {
    const known = TWILIO_ERRORS[data.code];
    return {
      code: data.code,
      windowClosed: Boolean(known && known.window),
      message: known ? known.msg : (data.message || err.message)
    };
  }
  if (provider === 'meta' && data && data.error) {
    const e = data.error;
    const known = META_ERRORS[e.error_subcode] || META_ERRORS[e.code];
    return {
      code: e.error_subcode || e.code,
      windowClosed: Boolean(known && known.window),
      message: known ? known.msg : (e.error_user_msg || e.message || err.message)
    };
  }
  if (err && err.code === 'ECONNABORTED') {
    return { code: null, windowClosed: false, message: 'Timed out reaching the WhatsApp provider' };
  }
  return { code: null, windowClosed: false, message: (err && err.message) || 'Unknown WhatsApp error' };
}

// ── Senders ──────────────────────────────────────────────────
async function twilioRequest(params) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const tok = process.env.TWILIO_AUTH_TOKEN;
  const r = await axios.post(
    `${twilioBase()}/2010-04-01/Accounts/${sid}/Messages.json`,
    new URLSearchParams(params).toString(),
    {
      auth: { username: sid, password: tok },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000
    }
  );
  return r.data;
}

async function metaRequest(payload) {
  const r = await axios.post(
    `${graphBase()}/${graphVersion()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    }
  );
  return r.data;
}

/**
 * Send a freeform text message. Only valid inside the 24-hour window; callers
 * that may be outside it should go through sendNotification below.
 *
 * @returns {{status:'sent'|'failed'|'unconfigured', detail?:string, windowClosed?:boolean}}
 */
async function sendText(to, text) {
  const provider = activeProvider();
  if (!provider) return { status: 'unconfigured', detail: describeMissing(null) };

  const num = normalizeE164(to);
  if (!num.e164) return { status: 'failed', detail: num.error };

  const chunks = splitForWhatsApp(text, provider === 'twilio' ? TWILIO_MAX : META_MAX);
  try {
    for (const chunk of chunks) {
      if (provider === 'twilio') {
        await twilioRequest({
          To: `whatsapp:${num.e164}`,
          From: `whatsapp:${normalizeE164(process.env.TWILIO_WHATSAPP_FROM).e164}`,
          Body: chunk
        });
      } else {
        await metaRequest({
          to: num.digits,
          type: 'text',
          text: { preview_url: false, body: chunk }
        });
      }
    }
    return { status: 'sent' };
  } catch (err) {
    const info = explainError(err, provider);
    return {
      status: 'failed',
      detail: info.code ? `[${info.code}] ${info.message}` : info.message,
      windowClosed: info.windowClosed
    };
  }
}

/**
 * Send the configured business-initiated template — the only thing WhatsApp
 * accepts outside the 24-hour window. The template is expected to take a
 * single body parameter, which is where the notification summary goes.
 */
async function sendTemplate(to, bodyParam) {
  const provider = activeProvider();
  if (!provider) return { status: 'unconfigured', detail: describeMissing(null) };
  const tpl = templateConfig();
  const num = normalizeE164(to);
  if (!num.e164) return { status: 'failed', detail: num.error };

  // WhatsApp rejects template parameters containing newlines or tabs, and
  // silently truncates very long ones.
  const param = String(bodyParam || '').replace(/\s+/g, ' ').trim().slice(0, 900);

  try {
    if (provider === 'twilio') {
      if (!tpl.contentSid) {
        return {
          status: 'skipped',
          detail: 'Outside the 24-hour window and no template configured — set TWILIO_CONTENT_SID to an approved template to allow business-initiated messages.'
        };
      }
      await twilioRequest({
        To: `whatsapp:${num.e164}`,
        From: `whatsapp:${normalizeE164(process.env.TWILIO_WHATSAPP_FROM).e164}`,
        ContentSid: tpl.contentSid,
        ContentVariables: JSON.stringify({ 1: param })
      });
    } else {
      if (!tpl.name) {
        return {
          status: 'skipped',
          detail: 'Outside the 24-hour window and no template configured — set WHATSAPP_TEMPLATE_NAME to an approved template to allow business-initiated messages.'
        };
      }
      await metaRequest({
        to: num.digits,
        type: 'template',
        template: {
          name: tpl.name,
          language: { code: tpl.language },
          components: [{ type: 'body', parameters: [{ type: 'text', text: param }] }]
        }
      });
    }
    return { status: 'sent', detail: 'Sent as a template (outside the 24-hour window)' };
  } catch (err) {
    const info = explainError(err, provider);
    return { status: 'failed', detail: info.code ? `[${info.code}] ${info.message}` : info.message };
  }
}

// ── The 24-hour customer service window ──────────────────────
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} prefs - a notification_preferences row
 * @returns {{open:boolean, lastInboundAt:string|null, expiresAt:string|null, minutesLeft:number|null}}
 */
function windowState(prefs) {
  const last = prefs && prefs.whatsapp_last_inbound_at;
  if (!last) return { open: false, lastInboundAt: null, expiresAt: null, minutesLeft: null };
  const at = new Date(last).getTime();
  if (!Number.isFinite(at)) return { open: false, lastInboundAt: null, expiresAt: null, minutesLeft: null };
  const expires = at + WINDOW_MS;
  const left = expires - Date.now();
  return {
    open: left > 0,
    lastInboundAt: new Date(at).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    minutesLeft: left > 0 ? Math.round(left / 60000) : 0
  };
}

/**
 * Deliver one notification, picking freeform or template based on the window.
 * This is what the channel fan-out calls.
 *
 * The window check is advisory, not authoritative: our record of the last
 * inbound message only exists if the webhook is reachable, which it is not on
 * a laptop. So when we believe the window is open we still try freeform and
 * fall back to the template if the provider disagrees.
 */
async function sendNotification(prefs, { title, body, summary }) {
  const to = prefs.whatsapp_to;
  const state = windowState(prefs);
  const text = `*${title}*\n\n${body}`.trim();

  if (state.open) {
    const r = await sendText(to, text);
    if (r.status !== 'failed' || !r.windowClosed) return r;
    // Our clock was wrong — the provider is the authority.
  } else if (!prefs.whatsapp_last_inbound_at) {
    // Never heard from them. On a deployment with no public webhook this is
    // the normal state, so try freeform rather than refusing outright.
    const r = await sendText(to, text);
    if (r.status !== 'failed' || !r.windowClosed) return r;
  }

  const tplResult = await sendTemplate(to, summary || title);
  if (tplResult.status === 'skipped') {
    return {
      status: 'skipped',
      detail: `${tplResult.detail} Reopen it by sending any WhatsApp message to the FinChat number.`
    };
  }
  return tplResult;
}

// ── Inbound ──────────────────────────────────────────────────
/**
 * Normalise a webhook body from either provider into the two things we care
 * about: who messaged, and what they said.
 *
 * @returns {Array<{from:string, text:string, provider:'twilio'|'meta'}>}
 */
function parseInbound(body) {
  const out = [];
  if (!body || typeof body !== 'object') return out;

  // Twilio posts one form-encoded message per request.
  if (typeof body.From === 'string' && body.From.startsWith('whatsapp:')) {
    const num = normalizeE164(body.From.replace('whatsapp:', ''));
    if (num.e164) out.push({ from: num.e164, text: String(body.Body || ''), provider: 'twilio' });
    return out;
  }

  // Meta posts a batch, and also uses this shape for delivery *statuses* —
  // which carry no `messages` array and must not be treated as inbound, or
  // every "delivered" receipt would silently reopen the 24-hour window.
  if (body.object === 'whatsapp_business_account' && Array.isArray(body.entry)) {
    for (const entry of body.entry) {
      for (const change of (entry.changes || [])) {
        const msgs = change.value && change.value.messages;
        if (!Array.isArray(msgs)) continue;
        for (const m of msgs) {
          // Meta reports `from` as bare digits ("919876543210"). That is
          // already E.164 minus the plus, so restore it rather than letting
          // normalizeE164 reject it as missing a country code.
          const raw = String(m.from || '');
          const num = normalizeE164(raw.startsWith('+') ? raw : '+' + raw);
          if (!num.e164) continue;
          out.push({
            from: num.e164,
            text: m.type === 'text' && m.text ? String(m.text.body || '') : '',
            provider: 'meta'
          });
        }
      }
    }
  }
  return out;
}

// ── Webhook authenticity ─────────────────────────────────────
// The webhook is a public, unauthenticated endpoint that writes to user
// records, so an unsigned POST must not be able to point somebody's WhatsApp
// channel at an attacker's number. Each provider signs differently.

/** Twilio: base64 HMAC-SHA1 over the full URL plus sorted form params. */
function verifyTwilioSignature(signature, url, params) {
  const tok = process.env.TWILIO_AUTH_TOKEN;
  if (!tok || !signature) return false;
  let data = url;
  for (const key of Object.keys(params || {}).sort()) {
    data += key + params[key];
  }
  const expected = crypto.createHmac('sha1', tok).update(Buffer.from(data, 'utf-8')).digest('base64');
  return timingSafeEqual(expected, signature);
}

/** Meta: 'sha256=' + HMAC-SHA256 over the raw request body. */
function verifyMetaSignature(header, rawBody) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret || !header || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(expected, header);
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── Link codes ───────────────────────────────────────────────
// Shared between routes/settings.js (which mints a code) and the webhook
// (which consumes it when the matching message arrives), so it lives here
// rather than in either route. In-memory and short-lived, matching the
// Telegram flow — a code that does not survive a restart just means the user
// taps "Link" again.
const linkCodes = new Map(); // code -> { userId, createdAt }
const LINK_TTL_MS = 15 * 60 * 1000;

// Math.random().toString(36).slice(2, 8) is NOT six characters — a value like
// 0.5 stringifies to "0.i" and yields one. A short code fails extractLinkCode's
// fixed-width match, so linking would break at random. Draw the characters
// explicitly instead, from an alphabet with no 0/O or 1/I to mistype.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;

function mintLinkCode(userId) {
  const now = Date.now();
  for (const [c, v] of linkCodes) if (now - v.createdAt > LINK_TTL_MS) linkCodes.delete(c);
  const bytes = crypto.randomBytes(CODE_LEN);
  let code = 'FC';
  for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  linkCodes.set(code, { userId, createdAt: now });
  return code;
}

function peekLinkCode(code) {
  const entry = linkCodes.get(String(code || '').toUpperCase());
  if (!entry) return null;
  if (Date.now() - entry.createdAt > LINK_TTL_MS) { linkCodes.delete(code); return null; }
  return entry;
}

/** Pull a FinChat link code out of an arbitrary inbound message body. */
function extractLinkCode(text) {
  const m = String(text || '').toUpperCase().match(new RegExp(`\\bFC[${CODE_ALPHABET}]{${CODE_LEN}}\\b`));
  return m ? m[0] : null;
}

function consumeLinkCode(code) {
  linkCodes.delete(String(code || '').toUpperCase());
}

module.exports = {
  activeProvider,
  configStatus,
  normalizeE164,
  splitForWhatsApp,
  sendText,
  sendTemplate,
  sendNotification,
  windowState,
  parseInbound,
  verifyTwilioSignature,
  verifyMetaSignature,
  mintLinkCode,
  peekLinkCode,
  extractLinkCode,
  consumeLinkCode,
  explainError
};
