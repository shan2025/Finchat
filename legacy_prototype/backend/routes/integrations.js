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
router.get('/google/connect', requireAuth, async (req, res) => {
  try {
    res.json({ url: google.buildAuthUrl(req.user.id), scopes: google.SCOPES });
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
  const userId = state ? google.readState(state) : null;
  if (!userId) {
    return res.redirect(settingsUrl({ google: 'error', reason: 'link expired — start again from Settings' }));
  }
  if (!code) {
    return res.redirect(settingsUrl({ google: 'error', reason: 'no authorisation code returned' }));
  }

  try {
    const tokens = await google.exchangeCode(String(code));

    // Google may return fewer scopes than were asked for. Storing a grant that
    // cannot read mail would leave the UI saying "connected" over an
    // integration that fails on first use.
    const granted = String(tokens.scope || '');
    if (!google.SCOPES.every(s => granted.includes(s))) {
      return res.redirect(settingsUrl({
        google: 'error',
        reason: 'the Gmail read permission was not granted, so there is nothing to read'
      }));
    }

    const { email } = await google.storeGrant(userId, tokens);
    res.redirect(settingsUrl({ google: 'connected', account: email || '' }));
  } catch (err) {
    const detail = (err.response && err.response.data && err.response.data.error_description) || err.message;
    console.error('Google OAuth callback error:', detail);
    res.redirect(settingsUrl({ google: 'error', reason: detail }));
  }
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
