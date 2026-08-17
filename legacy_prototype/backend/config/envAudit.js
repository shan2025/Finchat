// config/envAudit.js — boot-time report of optional configuration that is absent.
//
// This exists because render.yaml does NOT configure the running service: the
// Finchat-6 service was created through the Render dashboard, so the blueprint
// is documentation, not configuration. FRONTEND_URL was declared there, was
// never set on the dashboard, and the only symptom was every same-origin
// request being answered 403 — a failure nobody could trace back to a missing
// variable.
//
// Every entry below degrades silently when unset. The point is that the deploy
// log states which ones are missing and what each one costs, so the answer to
// "is this deploy actually configured?" is one screen of the log rather than a
// guess. Genuinely required values (JWT_SECRET, DATABASE_URL) are not listed:
// server.js refuses to boot without them, which is louder than any warning.

const CHECKS = [
  {
    // Any one of these satisfies the check — RENDER_EXTERNAL_URL is injected by
    // the platform, so on Render this passes with no configuration at all.
    keys: ['FRONTEND_URL', 'ALLOWED_ORIGINS', 'RENDER_EXTERNAL_URL'],
    cost: 'no browser origin is allowlisted; only same-origin and non-browser requests are accepted'
  },
  {
    keys: ['CRON_SECRET'],
    cost: '/api/cron/* refuses every request, so missions and briefings never fire'
  },
  {
    keys: ['GROQ_API_KEY'],
    cost: 'there is no cloud inference, and the Ollama fallback points at localhost, which does not exist on a hosted instance'
  },
  {
    keys: ['SMTP_USER', 'SMTP_PASS'],
    all: true,
    cost: 'email notifications report "unconfigured" and are dropped'
  },
  {
    keys: ['TELEGRAM_BOT_TOKEN'],
    cost: 'Telegram notifications are dropped'
  },
  {
    keys: ['GOOGLE_CLIENT_ID'],
    cost: 'the "Continue with Google" button is not rendered on the login and signup pages'
  },
  {
    keys: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
    all: true,
    cost: 'Web Push falls back to .vapid-keys.json on disk; where that does not survive a restart, ' +
      'each boot issues a new keypair and invalidates every existing browser subscription'
  },
  {
    keys: ['SOLANA_SECRET_KEY'],
    cost: 'the devnet wallet falls back to .solana-keypair.json on disk; where that does not survive ' +
      'a restart, a new wallet is generated each boot and the funded one is lost'
  },
  {
    keys: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
    all: true,
    cost: 'cache and working memory fall back to no-ops (correct, but slower)'
  },
  {
    keys: ['PINATA_API_KEY', 'PINATA_SECRET_KEY'],
    all: true,
    cost: 'IPFS archival uses its local fallback'
  }
];

function isSet(key) {
  return Boolean((process.env[key] || '').trim());
}

/**
 * @returns {string[]} the keys reported missing, for tests and callers that
 *          want to assert on the result rather than read the log.
 */
// Everything goes to stdout, warnings included. console.warn writes to stderr,
// which Render captures as a separate stream, and the block then interleaves
// with the startup banner instead of sitting above it.
const STDOUT = { warn: m => console.log(m), log: m => console.log(m) };

function auditEnv({ log = STDOUT } = {}) {
  const missing = [];

  for (const { keys, all, cost } of CHECKS) {
    // `all: true` means the feature needs every key (SMTP wants user AND pass);
    // otherwise the keys are alternatives and any one of them is enough.
    const absent = all ? keys.filter(k => !isSet(k)) : (keys.some(isSet) ? [] : keys);
    if (!absent.length) continue;
    missing.push(...absent);
    log.warn(`⚠️  ${absent.join(' / ')} not set — ${cost}`);
  }

  if (missing.length) {
    log.warn(`⚠️  ${missing.length} optional variable(s) unset. render.yaml documents the intended values, ` +
      'but it does not configure this service — set them in the Render dashboard under Environment.');
  } else {
    log.log('✅ Optional configuration: all present');
  }

  return missing;
}

module.exports = { auditEnv, CHECKS };
