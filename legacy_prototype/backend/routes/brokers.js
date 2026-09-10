// routes/brokers.js — connecting a brokerage account to FinChat.
//
// Same posture as routes/integrations.js: every endpoint that grants, refreshes
// or revokes access is a USER action behind requireAuth. There is no route here
// an agent can call to connect an account to itself, and the only verb the tool
// layer can reach is a refresh of holdings that are already connected.
//
// Credentials go IN and never come back out. Nothing in this file selects
// credentials_enc into a response; the status objects carry a label, a state and
// a timestamp.
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const brokers = require('../services/brokers');
const zerodha = require('../services/brokers/zerodha');

function settingsUrl(params) {
  return `/finchat_settings.html?${new URLSearchParams(params).toString()}`;
}

// ── GET /api/brokers ───────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    res.json(await brokers.list(req.user.id, zerodha.originOf(req)));
  } catch (err) {
    console.error('Broker list error:', err);
    res.status(500).json({ error: 'Failed to read broker connections', details: err.message });
  }
});

// ── POST /api/brokers/binance ──────────────────────────────────
// Body: { apiKey, apiSecret }. The key is verified read-only before it is
// stored — see services/brokers/binance.js assertReadOnly — so a 400 here is
// frequently "this key can trade", which is a refusal, not a failure.
router.post('/binance', requireAuth, async (req, res) => {
  try {
    const result = await brokers.connectBinance(req.user.id, req.body.apiKey, req.body.apiSecret);
    res.json({ connected: true, sync: result, connections: (await brokers.list(req.user.id)).connections });
  } catch (err) {
    console.warn('Binance connect refused:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/brokers/zerodha/app ──────────────────────────────
// Body: { apiKey, apiSecret } from the user's own app at developers.kite.trade.
// Returns the Kite login URL to send the browser to.
router.post('/zerodha/app', requireAuth, async (req, res) => {
  try {
    res.json(await brokers.saveZerodhaApp(
      req.user.id, req.body.apiKey, req.body.apiSecret, zerodha.originOf(req)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/brokers/zerodha/login ─────────────────────────────
// The daily re-login. Returns the URL rather than redirecting: the caller is a
// fetch() from Settings, and a 302 inside XHR is useless.
router.get('/zerodha/login', requireAuth, async (req, res) => {
  try {
    res.json(await brokers.zerodhaLoginUrl(req.user.id, zerodha.originOf(req)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── GET /api/brokers/zerodha/callback ──────────────────────────
// Kite redirects the BROWSER here, so there is no Authorization header. The
// signed `state` we passed through redirect_params is the only thing that says
// whose account this is — deliberately, and the same design as the Google
// callback. No requireAuth: an expired app session must not throw away a login
// the user just completed at their broker.
router.get('/zerodha/callback', async (req, res) => {
  const { request_token: requestToken, state, status } = req.query;

  if (status && status !== 'success') {
    return res.redirect(settingsUrl({ zerodha: 'cancelled' }));
  }
  const userId = state ? zerodha.readState(String(state)) : null;
  if (!userId) {
    return res.redirect(settingsUrl({ zerodha: 'error', reason: 'the login link expired — start again from Settings' }));
  }
  if (!requestToken) {
    return res.redirect(settingsUrl({ zerodha: 'error', reason: 'Kite returned no request token' }));
  }

  try {
    const result = await brokers.completeZerodhaLogin(userId, String(requestToken));
    return res.redirect(settingsUrl({
      zerodha: result.ok ? 'connected' : 'error',
      holdings: result.ok ? String(result.holdings) : '',
      reason: result.ok ? '' : (result.message || '')
    }));
  } catch (err) {
    console.error('Zerodha callback error:', err.message);
    return res.redirect(settingsUrl({ zerodha: 'error', reason: err.message }));
  }
});

// ── POST /api/brokers/:broker/sync ─────────────────────────────
router.post('/:broker/sync', requireAuth, async (req, res) => {
  const broker = String(req.params.broker || '').toLowerCase();
  if (broker === 'all') {
    // A person pressed the button, so try the manual-only brokers too.
    return res.json({ results: await brokers.syncAll(req.user.id, { includeManualOnes: true }) });
  }
  if (!brokers.isBroker(broker)) return res.status(404).json({ error: `Unknown broker "${broker}"` });
  try {
    res.json(await brokers.sync(req.user.id, broker));
  } catch (err) {
    console.error(`${broker} sync error:`, err);
    res.status(500).json({ error: 'Sync failed', details: err.message });
  }
});

// ── DELETE /api/brokers/:broker ────────────────────────────────
router.delete('/:broker', requireAuth, async (req, res) => {
  const broker = String(req.params.broker || '').toLowerCase();
  if (!brokers.isBroker(broker)) return res.status(404).json({ error: `Unknown broker "${broker}"` });
  try {
    const result = await brokers.disconnect(req.user.id, broker);
    res.json(result || { disconnected: false, wasConnected: false });
  } catch (err) {
    console.error(`${broker} disconnect error:`, err);
    res.status(500).json({ error: 'Failed to disconnect', details: err.message });
  }
});

module.exports = router;
