// routes/integrations.js — connecting third-party accounts to FinChat.
//
// Currently one: Google, for read-only Gmail access so Rasha can work from the
// job alerts that already land in the user's inbox.
//
// The consent round-trip is deliberately the USER's action end to end. There is
// no endpoint here that an agent can call to grant itself a mailbox, and the
// callback trusts nothing from the query string except a state token this server
// signed itself.
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const google = require('../services/googleOAuth');

// Where the browser lands after consent. The Settings page reads the query
// string and shows the outcome.
//
// RELATIVE, deliberately: the callback is served by the backend, which also
// serves the frontend, so staying on the request's own origin lands the user
// back where they actually are. Building an absolute URL from FRONTEND_URL sent
// them to :5500 (a Live Server dev origin) even when they opened the app at
// :3000 — the grant succeeded but the landing page was dead.
function settingsUrl(params) {
  const qs = new URLSearchParams(params).toString();
  return `/finchat_settings.html?${qs}`;
}

// ── GET /api/integrations/google/status ────────────────────────
router.get('/google/status', requireAuth, async (req, res) => {
  try {
    res.json(await google.status(req.user.id));
  } catch (err) {
    console.error('Google status error:', err);
    res.status(500).json({ error: 'Failed to read Google integration status', details: err.message });
  }
});

// ── GET /api/integrations/google/connect ───────────────────────
// Returns the consent URL rather than redirecting: the caller is a fetch() from
// the Settings page, and a 302 to accounts.google.com inside XHR is useless.
// ?feature=drive connects Drive (file names and links) instead of Gmail; each
// is its own consent, and neither asks for the other's permission.
router.get('/google/connect', requireAuth, async (req, res) => {
  try {
    const feature = req.query.feature === 'drive' ? 'drive' : 'gmail';
    res.json({ url: google.buildAuthUrl(req.user.id, [feature]), scopes: google.scopesFor([feature]) });
  } catch (err) {
    res.status(503).json({ error: err.message, redirectUri: google.redirectUri() });
  }
});

// ── GET /api/integrations/google/callback ──────────────────────
// Google redirects the BROWSER here, so there is no Authorization header — the
// signed `state` is the only thing identifying the user, which is exactly what
// it is for. No requireAuth: an expired app session must not lose a consent the
// user just gave.
router.get('/google/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  if (oauthError) {
    // The user pressed Cancel. Not an error worth a stack trace.
    return res.redirect(settingsUrl({ google: 'cancelled' }));
  }
  const st = state ? google.readStateFull(state) : null;
  const userId = st ? st.uid : null;
  if (!userId) {
    return res.redirect(settingsUrl({ google: 'error', reason: 'link expired — start again from Settings' }));
  }
  if (!code) {
    return res.redirect(settingsUrl({ google: 'error', reason: 'no authorisation code returned' }));
  }

  try {
    const tokens = await google.exchangeCode(String(code));

    // Google may return fewer scopes than were asked for (the consent screen
    // lets the user untick one). Storing a grant that cannot do what was asked
    // would leave the UI saying "connected" over an integration that fails on
    // first use. Checked against what THIS consent asked for — connecting
    // Drive must not fail because Gmail was never granted, and vice versa.
    const granted = String(tokens.scope || '').split(/\s+/);
    if (!google.scopesFor(st.features).every(s => granted.includes(s))) {
      const what = st.features.includes('drive') ? 'Drive file-list' : 'Gmail read';
      return res.redirect(settingsUrl({
        google: 'error',
        reason: `the ${what} permission was not granted, so there is nothing to connect`
      }));
    }

    const { email } = await google.storeGrant(userId, tokens);
    res.redirect(settingsUrl({ google: 'connected', feature: st.features.join(','), account: email || '' }));
  } catch (err) {
    const detail = (err.response && err.response.data && err.response.data.error_description) || err.message;
    console.error('Google OAuth callback error:', detail);
    res.redirect(settingsUrl({ google: 'error', reason: detail }));
  }
});

// ── Drive: find files by name ──────────────────────────────────
// GET  /google/drive/search?q=duxbe pos   → { files: [{title, url, kindLabel, …}] }
// POST /google/drive/resolve {names:[…]}  → best match per name + alternatives
// Names and links only (drive.metadata.readonly). A DriveError carries a code
// the UI turns into "connect Drive" rather than a failure.
function driveFail(res, err) {
  const Drive = require('../services/googleDrive');
  if (err instanceof Drive.DriveError) {
    const status = err.code === 'not_connected' ? 409 : err.code === 'not_configured' ? 503 : 502;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  console.error('Drive error:', err);
  return res.status(500).json({ error: 'Drive search failed' });
}

router.get('/google/drive/search', requireAuth, async (req, res) => {
  try {
    const Drive = require('../services/googleDrive');
    const files = await Drive.search(req.user.id, String(req.query.q || '').slice(0, 200), { limit: req.query.limit });
    res.json({ files });
  } catch (err) { driveFail(res, err); }
});

router.post('/google/drive/resolve', requireAuth, async (req, res) => {
  try {
    const Drive = require('../services/googleDrive');
    const names = Array.isArray(req.body && req.body.names) ? req.body.names.map(n => String(n).slice(0, 200)) : [];
    if (!names.length) return res.status(400).json({ error: 'names is required' });
    res.json({ results: await Drive.resolveNames(req.user.id, names) });
  } catch (err) { driveFail(res, err); }
});

// ── DELETE /api/integrations/google ────────────────────────────
router.delete('/google', requireAuth, async (req, res) => {
  try {
    // Revokes at Google as well as deleting the row — otherwise FinChat stays
    // listed with a live grant on the user's account permissions page.
    const had = await google.disconnect(req.user.id);
    res.json({ disconnected: true, wasConnected: had });
  } catch (err) {
    console.error('Google disconnect error:', err);
    res.status(500).json({ error: 'Failed to disconnect', details: err.message });
  }
});

module.exports = router;
