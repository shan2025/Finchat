// system_panels.js — Sprint 6.1
//
// The Proof / Tokens / Rules / AI Scans panels used to live in a right-hand
// aside on finchat_chat.html. They now live on finchat_audit.html, and the
// chat page keeps the full width for the conversation.
//
// This file follows the shared-JS pattern (see notifications_widget.js): a
// page only needs a single  <script src="system_panels.js"></script>
// include, and the widget figures out what to do from the DOM:
//
//   • finchat_audit.html — has #spProofExtra / #spEconomy / #spRules /
//     #spScans → fill them with real backend data (proof chain, token
//     ledger, governance rules, Sentinel fraud log).
//   • finchat_chat.html — has #messages but no panels → install a HIDDEN
//     stub container carrying the legacy element ids (proofLog, statHeight,
//     tokenBig, scanLog, …). The page's inline script still writes its live
//     updates into those ids; with the aside gone they land in the stubs
//     instead of crashing the message flow.
//
// Re-wire checklist after a design-tool regen of chat: re-add the single
// script include. Nothing else.

(function () {
  'use strict';

  // ── auth + fetch helpers ──────────────────────────────────
  function getToken() {
    try {
      const s = JSON.parse(sessionStorage.getItem('finchat_user') || 'null');
      if (s && s.token) return s.token;
    } catch (e) { /* fall through */ }
    try {
      const s = JSON.parse(localStorage.getItem('finchat_session') || 'null');
      if (s && s.token) return s.token;
    } catch (e) { /* fall through */ }
    return localStorage.getItem('finchat_token') || localStorage.getItem('finchat_jwt') || '';
  }
  var API_BASE = (location.protocol.indexOf('http') === 0) ? location.origin : 'http://localhost:3000';

  // Routed through the shared client so a request this file makes on boot is
  // coalesced with the identical one the host page makes — /api/tokens/balance
  // was being fetched twice on every chat load, once from each side. Falls back
  // to a plain fetch if api_client.js is not on the page.
  async function api(path) {
    if (window.fcApi) return window.fcApi.get(path);
    const res = await fetch(API_BASE + path, {
      headers: { 'Authorization': 'Bearer ' + getToken() }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Channel that carries the proof chain — same preference order the chat
  // page uses: a channel literally named "general", else system_channel,
  // else the first one.
  async function resolveChainChannel() {
    const d = await api('/api/messages/channels');
    const list = d.channels || [];
    const c = list.find(x => (x.name || '').toLowerCase() === 'general')
      || list.find(x => (x.id || x.channel_id) === 'system_channel')
      || list[0];
    return c ? (c.id || c.channel_id) : null;
  }

  // ══════════════════════════════════════════════════════════
  // CHAT: hidden stubs so the inline message-flow code keeps working
  // ══════════════════════════════════════════════════════════
  const LEGACY_IDS = [
    'proofLog', 'scanLog', 'txList',
    'statHeight', 'statFlags', 'statSpent', 'statPenalties',
    'tokenBig', 'tokenBar',
    'aiTitle', 'aiDesc',
    'modelLabel',
    'verifyChainBtn', 'verifyStatusBanner',
    'tab-proof', 'tab-tokens', 'tab-gov', 'tab-ai'
  ];
  function installChatStubs() {
    if (document.getElementById('__systemPanelStubs')) return;
    const host = document.createElement('div');
    host.id = '__systemPanelStubs';
    host.style.cssText = 'display:none!important;position:absolute;pointer-events:none;';
    host.setAttribute('aria-hidden', 'true');
    for (const id of LEGACY_IDS) {
      if (document.getElementById(id)) continue; // page still has the real one
      const el = document.createElement(id === 'verifyChainBtn' ? 'button' : 'div');
      el.id = id;
      host.appendChild(el);
    }
    document.body.appendChild(host);
  }

  // ══════════════════════════════════════════════════════════
  // AUDIT: the four real panels
  // ══════════════════════════════════════════════════════════
  const C = {
    brown: '#4B3621', cream: '#FDFBF7', card: '#F7F4EA', border: '#E5DEC5',
    text: '#2D241B', sub: '#6B5D4E', gold: '#C19C4D',
    red: '#b0472e', amber: '#b45309', green: '#15803d'
  };
  const RULES = [
    ['Message Cost', 'Each sent message costs 5 CHAT tokens. Enforces accountability.'],
    ['Fraud Penalty — HIGH', 'HIGH risk messages: −20 tokens, message quarantined with red border.'],
    ['Fraud Penalty — MEDIUM', 'MEDIUM risk messages: −10 tokens, flagged with amber warning.'],
    ['Proof Chaining', 'Every message is SHA-256 hashed and chained to the previous hash — tamper-evident by design.'],
    ['Async Blockchain Anchoring', 'Hashes are anchored to Solana devnet in the background. No chat lag — confirmation arrives silently.'],
    ['Zero-Token Freeze', 'Messaging is disabled when balance reaches 0. Economic participation enforced.']
  ];

  function card(inner, extra) {
    return '<div style="background:' + C.card + ';border:1px solid ' + C.border + ';border-radius:14px;padding:14px;' + (extra || '') + '">' + inner + '</div>';
  }
  function sectionLabel(t) {
    return '<div style="font-family:\'JetBrains Mono\',monospace;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:' + C.brown + ';margin:12px 0 8px;">' + t + '</div>';
  }

  // The audit page provides one container per moved panel; fill whichever
  // exist. (spProofExtra sits inside the existing Proof tab, below the
  // selected-block cards; the others are whole tab bodies.)
  function mountAudit() {
    const t = id => document.getElementById(id);
    if (t('spProofExtra')) renderProof(t('spProofExtra'));
    if (t('spEconomy')) renderEconomy(t('spEconomy'));
    if (t('spRules')) renderRules(t('spRules'));
    if (t('spScans')) renderScans(t('spScans'));
  }

  // ── Proof panel: live chain log + integrity verification ──
  async function renderProof(el) {
    el.innerHTML = '<div style="color:' + C.sub + ';font-size:12px;padding:12px;">Loading proof chain…</div>';
    let chain = [];
    try { chain = (await api('/api/messages/proof/global')).chain || []; }
    catch (e) { /* render what we can */ }
    const height = chain.length ? Math.max.apply(null, chain.map(b => b.chain_height || 0)) : 0;
    const anchored = chain.filter(b => b.solana_tx).length;

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0 10px;">
        ${card('<div style="font-size:20px;font-weight:800;font-family:\'JetBrains Mono\',monospace;color:' + C.text + ';text-align:center" id="spChainHeight">' + height + '</div><div style="font-size:10px;color:' + C.sub + ';text-align:center">Chain Height</div>')}
        ${card('<div style="font-size:20px;font-weight:800;font-family:\'JetBrains Mono\',monospace;color:' + C.text + ';text-align:center">' + anchored + '</div><div style="font-size:10px;color:' + C.sub + ';text-align:center">Anchored on Solana</div>')}
      </div>
      <button id="spVerifyBtn" style="width:100%;padding:10px;border-radius:999px;border:1px solid ${C.brown};background:${C.brown};color:${C.cream};font-weight:700;font-size:12px;cursor:pointer;margin-bottom:8px;">Verify Chain Integrity</button>
      <div id="spVerifyBanner" style="display:none;border-radius:10px;padding:10px 12px;font-size:12px;margin-bottom:10px;"></div>
      ${sectionLabel('Proof log (latest ' + Math.min(chain.length, 25) + ')')}
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${chain.slice(0, 25).map(b => card(
          '<div style="font-family:\'JetBrains Mono\',monospace;font-size:10px;line-height:1.8;color:' + C.sub + ';">' +
            '<div><b style="color:' + C.text + '">HT</b> #' + (b.chain_height != null ? b.chain_height : '—') + (b.solana_tx ? ' ⚓' : '') +
            ' · <b style="color:' + C.text + '">FROM</b> ' + esc(b.sender_name || b.title || 'system') +
            (b.timestamp ? ' · ' + new Date(b.timestamp).toLocaleString() : '') + '</div>' +
            '<div style="word-break:break-all;"><b style="color:' + C.text + '">HASH</b> ' + esc(String(b.hash || '').substring(0, 40)) + '…</div>' +
            (b.solana_tx
              ? '<div style="word-break:break-all;"><b style="color:' + C.text + '">SOL</b> <a href="https://explorer.solana.com/tx/' + esc(b.solana_tx) + '?cluster=devnet" target="_blank" style="color:' + C.brown + ';font-weight:700;">' + esc(String(b.solana_tx).substring(0, 24)) + '…</a></div>'
              : '') +
          '</div>')).join('')
          || '<div style="color:' + C.sub + ';font-size:12px;padding:12px;text-align:center;">Proof log is empty — send a message in Chat and it appears here with its chain hash.</div>'}
      </div>`;

    document.getElementById('spVerifyBtn').onclick = async () => {
      const banner = document.getElementById('spVerifyBanner');
      banner.style.display = 'block';
      banner.style.background = C.card; banner.style.border = '1px solid ' + C.border; banner.style.color = C.sub;
      banner.textContent = '🔍 Checking full chain integrity…';
      try {
        const ch = await resolveChainChannel();
        if (!ch) throw new Error('no channel');
        const d = await api('/api/messages/' + encodeURIComponent(ch) + '/proof');
        const v = d.verification || {};
        if (v.valid) {
          banner.style.border = '1px solid ' + C.green; banner.style.color = C.green;
          banner.innerHTML = '✅ <b>Chain verified.</b> All ' + v.totalBlocks + ' blocks linked and signed correctly — no tampering detected.';
        } else {
          banner.style.border = '1px solid ' + C.red; banner.style.color = C.red;
          banner.innerHTML = '🚨 <b>Integrity compromised!</b><br>' + (v.issues || []).map(i => '👉 ' + esc(i)).join('<br>');
        }
      } catch (e) {
        banner.style.border = '1px solid ' + C.red; banner.style.color = C.red;
        banner.textContent = '❌ Verification failed. Could not reach server.';
      }
    };
  }

  // ── Economy panel: balance + real transaction ledger ──────
  async function renderEconomy(el) {
    el.innerHTML = '<div style="color:' + C.sub + ';font-size:12px;padding:12px;">Loading token ledger…</div>';
    let bal = null, frozen = false, txs = [];
    try { const d = await api('/api/tokens/balance'); bal = d.balance; frozen = !!d.frozen; } catch (e) { }
    try { txs = (await api('/api/tokens/history?limit=25')).transactions || []; } catch (e) { }
    let spent = 0, penalties = 0;
    for (const tx of txs) {
      const isPen = tx.type === 'penalty' || /penalt|fraud|freeze/i.test(tx.reason || '');
      if (isPen) penalties += Math.abs(tx.amount);
      else if (tx.amount < 0) spent += Math.abs(tx.amount);
    }
    el.innerHTML = `
      ${card('<div style="display:flex;justify-content:space-between;align-items:baseline;"><span style="font-size:11px;font-weight:600;color:' + C.sub + '">Token Balance' + (frozen ? ' · <b style="color:' + C.red + '">FROZEN</b>' : '') + '</span><span style="font-family:\'JetBrains Mono\',monospace;font-weight:800;color:' + C.text + '">' + (bal != null ? bal : '—') + ' CHAT</span></div>', 'margin-bottom:10px;')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
        ${card('<div style="font-size:20px;font-weight:800;font-family:\'JetBrains Mono\',monospace;color:' + C.text + ';text-align:center">' + spent + '</div><div style="font-size:10px;color:' + C.sub + ';text-align:center">Spent (last 25 tx)</div>')}
        ${card('<div style="font-size:20px;font-weight:800;font-family:\'JetBrains Mono\',monospace;color:' + C.red + ';text-align:center">' + penalties + '</div><div style="font-size:10px;color:' + C.sub + ';text-align:center">Penalties</div>')}
      </div>
      ${sectionLabel('Transactions')}
      <div style="display:flex;flex-direction:column;">
        ${txs.map(tx =>
          '<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 2px;border-bottom:1px solid ' + C.border + ';font-size:12px;">' +
            '<div style="min-width:0;">' +
              '<div style="font-weight:600;color:' + C.text + ';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(tx.reason || tx.type) + '</div>' +
              '<div style="font-family:\'JetBrains Mono\',monospace;font-size:10px;color:' + C.sub + '">' + (tx.created_at ? new Date(tx.created_at).toLocaleString() : '') + '</div>' +
            '</div>' +
            '<div style="font-family:\'JetBrains Mono\',monospace;font-weight:800;color:' + (tx.amount >= 0 ? C.green : C.red) + ';white-space:nowrap;">' + (tx.amount >= 0 ? '+' : '') + tx.amount + '</div>' +
          '</div>').join('')
          || '<div style="color:' + C.sub + ';font-size:12px;padding:12px;text-align:center;">No transactions yet.</div>'}
      </div>`;
  }

  // ── Rules panel ────────────────────────────────────────────
  function renderRules(el) {
    el.innerHTML = RULES.map(r => card(
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
        '<span style="width:8px;height:8px;border-radius:50%;background:' + C.green + ';display:inline-block;"></span>' +
        '<b style="font-size:13px;color:' + C.text + '">' + r[0] + '</b>' +
      '</div>' +
      '<div style="font-size:12px;color:' + C.sub + ';line-height:1.5;">' + r[1] + '</div>', 'margin-bottom:8px;')).join('');
  }

  // ── AI Scans panel: real fraud log ─────────────────────────
  async function renderScans(el) {
    el.innerHTML = '<div style="color:' + C.sub + ';font-size:12px;padding:12px;">Loading AI scan log…</div>';
    let logs = [];
    try {
      const ch = await resolveChainChannel();
      if (ch) logs = (await api('/api/messages/' + encodeURIComponent(ch) + '/fraud')).logs || [];
    } catch (e) { }
    el.innerHTML = `
      ${card('<b style="font-size:12px;color:' + C.text + '">AI Monitor — Sentinel</b><div style="font-size:11px;color:' + C.sub + ';margin-top:2px;">Pattern-based fraud detection runs on every message. Flags are listed below.</div>', 'margin-bottom:10px;')}
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${logs.map(l => {
          const col = l.risk_level === 'HIGH' ? C.red : l.risk_level === 'MEDIUM' ? C.amber : C.green;
          return card(
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
              '<b style="font-size:12px;color:' + C.text + '">' + esc(l.sender_name || '—') + '</b>' +
              '<span style="border:1px solid ' + col + ';color:' + col + ';font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;">' + esc(l.risk_level || '?') + '</span>' +
            '</div>' +
            '<div style="font-size:11px;color:' + C.sub + ';margin-top:3px;">' + esc(l.reason || '') + '</div>' +
            '<div style="font-family:\'JetBrains Mono\',monospace;font-size:10px;color:' + C.sub + ';margin-top:2px;">' + (l.created_at ? new Date(l.created_at).toLocaleString() : '') + '</div>');
        }).join('')
        || '<div style="color:' + C.sub + ';font-size:12px;padding:12px;text-align:center;">🔍 No fraud alerts — the Sentinel found nothing to flag.</div>'}
      </div>`;
  }

  // ── auto-detect which page we're on ───────────────────────
  let booted = false;
  function boot() {
    if (booted) return;
    if (document.getElementById('spProofExtra') || document.getElementById('spEconomy')) {
      booted = true; mountAudit(); return;
    }
    // Chat page with the aside removed → keep its inline JS alive. Stubs must
    // exist BEFORE the page's inline script starts writing live updates, so
    // boot runs immediately at parse time (the include sits below the markup
    // it inspects), with DOMContentLoaded only as a fallback.
    if (document.getElementById('messages') && !document.getElementById('tab-proof')) {
      booted = true;
      installChatStubs();
    }
  }
  if (document.body) boot();
  if (!booted) document.addEventListener('DOMContentLoaded', boot);

  // Expose for manual re-wiring / debugging.
  window.SystemPanels = { installChatStubs, mountAudit, boot };
})();
