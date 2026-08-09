// missions_widget.js — Sprint 7 missions UI for the Agents page.
// Renders a "Missions" card under the agent configuration panel: per-agent
// mission list (enable/pause, cadence, budget, last result, run-now, delete),
// a create form, and pending human-approval cards (approve/reject).
// Shared-JS pattern: survives design-tool regens — re-add the include if wiped.
(function () {
  var API = (typeof window.API_URL === 'string' && window.API_URL)
    ? window.API_URL
    : (location.protocol.indexOf('http') === 0 ? location.origin : 'http://localhost:3000');

  function token() {
    try {
      var raw = sessionStorage.getItem('finchat_user') || localStorage.getItem('finchat_session');
      if (raw) { var s = JSON.parse(raw); if (s && s.token) return s.token; }
    } catch (e) {}
    return null;
  }
  function H() { return { 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' }; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg) {
    if (typeof window.showToast === 'function') return window.showToast(msg);
    var t = document.getElementById('toast');
    if (t) { t.textContent = msg; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, 2600); }
    else console.log('[missions]', msg);
  }

  var CADENCES = [['15m', 'Every 15 min'], ['1h', 'Hourly'], ['6h', 'Every 6 h'], ['daily', 'Daily (08:00)']];
  var state = { missions: [], approvals: [], agent: 'plato', busy: false };

  function currentAgent() {
    return window.currentAgentId || window.selectedAgent || state.agent || 'plato';
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function card() {
    var el = document.getElementById('missionsCard');
    if (el) return el;
    // Mount below the main config card in the right column
    var right = document.querySelector('main .lg\\:col-span-3') || document.querySelector('main');
    if (!right) return null;
    el = document.createElement('div');
    el.id = 'missionsCard';
    el.className = 'bg-cream-bg border border-border-color rounded-3xl p-8 shadow-sm flex flex-col gap-5 mt-8';
    right.appendChild(el);
    return el;
  }

  function render() {
    var el = card();
    if (!el) return;
    var agent = currentAgent();
    var mine = state.missions.filter(function (m) { return m.agent_id === agent; });
    var approvals = state.approvals;

    var approvalsHtml = approvals.length ? (
      '<div style="border:1px solid #d4af37; background:#fdf6e3; border-radius:16px; padding:14px;">' +
        '<div style="font-weight:700; color:#7a5a12; margin-bottom:8px;">✋ Waiting for your approval</div>' +
        approvals.map(function (x) {
          var info = x.waiting_info || {};
          return '<div style="display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px solid #eadfc0;">' +
            '<div style="flex:1; min-width:0;">' +
              '<div style="font-size:13px; font-weight:700; color:#3a2e23;">' + esc(x.assigned_agent || 'agent') + ' → tool "' + esc(info.pendingTool || '?') + '"</div>' +
              '<div style="font-size:12px; color:#8c7a6b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + esc(x.goal) + '</div>' +
            '</div>' +
            '<button data-approve="' + esc(x.execution_id) + '" style="padding:7px 14px; border-radius:999px; border:none; background:#16a34a; color:#fff; font-weight:700; font-size:12px; cursor:pointer;">Approve</button>' +
            '<button data-reject="' + esc(x.execution_id) + '" style="padding:7px 14px; border-radius:999px; border:1px solid #b0472e; background:transparent; color:#b0472e; font-weight:700; font-size:12px; cursor:pointer;">Reject</button>' +
          '</div>';
        }).join('') +
      '</div>'
    ) : '';

    var rows = mine.length ? mine.map(function (m) {
      var status = m.enabled
        ? '<span style="color:#16a34a; font-weight:700;">● Active</span>'
        : '<span style="color:#8c7a6b; font-weight:700;">◌ Paused</span>';
      var fail = (m.consecutive_failures > 0)
        ? ' <span style="color:#b0472e;">(' + m.consecutive_failures + ' fail' + (m.consecutive_failures > 1 ? 's' : '') + ')</span>' : '';
      return '<div style="border:1px solid #d6ccbc; border-radius:16px; padding:14px; background:#fffaf0;">' +
        '<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">' +
          '<div style="flex:1; min-width:180px;">' +
            '<div style="font-weight:700; color:#3a2e23;">' + esc(m.title) + '</div>' +
            '<div style="font-size:12px; color:#8c7a6b;">' + status + fail + ' · every ' + esc(m.cadence) + ' · ≤' + m.max_tokens_per_run + ' tok/run</div>' +
          '</div>' +
          '<button data-toggle="' + esc(m.mission_id) + '" data-on="' + (m.enabled ? '1' : '0') + '" style="padding:7px 14px; border-radius:999px; border:none; background:' + (m.enabled ? '#8c7a6b' : '#16a34a') + '; color:#fff; font-weight:700; font-size:12px; cursor:pointer;">' + (m.enabled ? 'Pause' : 'Enable') + '</button>' +
          '<button data-run="' + esc(m.mission_id) + '" style="padding:7px 14px; border-radius:999px; border:1px solid #3a2e23; background:transparent; color:#3a2e23; font-weight:700; font-size:12px; cursor:pointer;">Run now</button>' +
          '<button data-del="' + esc(m.mission_id) + '" title="Delete mission" style="padding:7px 10px; border-radius:999px; border:none; background:transparent; color:#b0472e; font-size:15px; cursor:pointer;">✕</button>' +
        '</div>' +
        '<div style="font-size:12px; color:#5a4d3c; margin-top:8px; line-height:1.45;">' + esc(m.goal).slice(0, 220) + (m.goal.length > 220 ? '…' : '') + '</div>' +
        '<div style="font-size:11.5px; color:#8c7a6b; margin-top:8px;">Last run: ' + fmtTime(m.last_run_at) + (m.enabled ? ' · Next ≈ ' + fmtTime(m.next_run_at) : '') + '</div>' +
        (m.last_result_preview ? '<details style="margin-top:6px;"><summary style="font-size:12px; color:#8c491a; cursor:pointer; font-weight:600;">Last result</summary><div class="markdown-body" style="font-size:12px; color:#5a4d3c; margin-top:6px; max-height:250px; overflow-y:auto; background:#f5ead8; border-radius:10px; padding:12px;">' + (window.marked && window.DOMPurify ? DOMPurify.sanitize(marked.parse(m.last_result_preview)) : esc(m.last_result_preview).replace(/\\n/g, '<br>')) + '</div></details>' : '') +
      '</div>';
    }).join('') : '<div style="font-size:13px; color:#8c7a6b; padding:4px 2px;">No missions for this agent yet — create one below. Missions run on a schedule while the server is up; new and seeded missions start <b>paused</b> so nothing spends tokens until you enable it.</div>';

    el.innerHTML =
      '<div style="display:flex; align-items:center; gap:10px;">' +
        '<h3 class="text-lg font-bold text-[#3a2e23]" style="flex:1;">Missions <span style="font-size:12px; color:#8c7a6b; font-weight:500;">— autonomous scheduled goals for <b>' + esc(agent) + '</b></span></h3>' +
      '</div>' +
      approvalsHtml +
      '<div id="missionRows" style="display:flex; flex-direction:column; gap:10px;">' + rows + '</div>' +
      '<div style="border-top:1px dashed #d6ccbc; padding-top:14px;">' +
        '<div style="font-weight:700; color:#3a2e23; font-size:14px; margin-bottom:8px;">New mission for ' + esc(agent) + '</div>' +
        '<div style="display:flex; flex-direction:column; gap:8px;">' +
          '<input id="mwTitle" placeholder="Title — e.g. Morning market scan" style="padding:10px 13px; border-radius:12px; border:1px solid #d6ccbc; background:#fffaf0; font-family:inherit; font-size:13px;">' +
          '<textarea id="mwGoal" rows="3" placeholder="Goal — what should the agent do each run? Be specific about tools and output." style="padding:10px 13px; border-radius:12px; border:1px solid #d6ccbc; background:#fffaf0; font-family:inherit; font-size:13px; resize:vertical;"></textarea>' +
          '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">' +
            '<select id="mwCadence" style="padding:9px 12px; border-radius:12px; border:1px solid #d6ccbc; background:#fffaf0; font-family:inherit; font-size:13px;">' +
              CADENCES.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === 'daily' ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') +
            '</select>' +
            '<label style="font-size:12px; color:#8c7a6b;">Budget <input id="mwBudget" type="number" value="4000" min="500" max="20000" step="500" style="width:80px; padding:8px 10px; border-radius:10px; border:1px solid #d6ccbc; background:#fffaf0; font-family:inherit; font-size:13px;"> tok/run</label>' +
            '<div style="flex:1;"></div>' +
            '<button id="mwCreate" style="padding:10px 20px; border-radius:999px; border:none; background:#3a2e23; color:#fff; font-weight:700; font-size:13px; cursor:pointer;">Create (paused)</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Wire buttons
    el.querySelectorAll('[data-toggle]').forEach(function (b) {
      b.onclick = function () { setEnabled(b.dataset.toggle, b.dataset.on !== '1'); };
    });
    el.querySelectorAll('[data-run]').forEach(function (b) {
      b.onclick = function () { runNow(b.dataset.run, b); };
    });
    el.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () { if (confirm('Delete this mission?')) del(b.dataset.del); };
    });
    el.querySelectorAll('[data-approve]').forEach(function (b) {
      b.onclick = function () { decide(b.dataset.approve, 'approve', b); };
    });
    el.querySelectorAll('[data-reject]').forEach(function (b) {
      b.onclick = function () { decide(b.dataset.reject, 'reject', b); };
    });
    var createBtn = el.querySelector('#mwCreate');
    if (createBtn) createBtn.onclick = create;
  }

  async function refresh() {
    if (!token()) return;
    try {
      var [mRes, aRes] = await Promise.all([
        fetch(API + '/api/missions', { headers: H() }),
        fetch(API + '/api/executions?state=waiting', { headers: H() })
      ]);
      if (mRes.ok) state.missions = (await mRes.json()).missions || [];
      if (aRes.ok) {
        state.approvals = ((await aRes.json()).executions || [])
          .filter(function (x) { return x.wait_reason === 'human_approval'; });
      }
      render();
    } catch (e) { console.log('missions refresh failed', e); }
  }

  async function setEnabled(id, enabled) {
    var r = await fetch(API + '/api/missions/' + id, { method: 'PUT', headers: H(), body: JSON.stringify({ enabled: enabled }) });
    if (r.ok) { toast(enabled ? 'Mission enabled — it will run on schedule' : 'Mission paused'); refresh(); }
    else toast('Could not update mission');
  }

  async function runNow(id, btn) {
    if (state.busy) return;
    state.busy = true;
    var old = btn.textContent;
    btn.textContent = 'Running…'; btn.disabled = true;
    try {
      var r = await fetch(API + '/api/missions/' + id + '/run-now', { method: 'POST', headers: H() });
      var d = await r.json();
      if (r.ok && d.result && d.result.success) toast('Mission run complete');
      else toast('Mission run failed: ' + ((d.result && d.result.error) || d.error || 'unknown'));
    } catch (e) { toast('Mission run error: ' + e.message); }
    state.busy = false;
    btn.textContent = old; btn.disabled = false;
    refresh();
  }

  async function del(id) {
    var r = await fetch(API + '/api/missions/' + id, { method: 'DELETE', headers: H() });
    if (r.ok) { toast('Mission deleted'); refresh(); } else toast('Could not delete mission');
  }

  async function create() {
    var title = document.getElementById('mwTitle').value.trim();
    var goal = document.getElementById('mwGoal').value.trim();
    var cadence = document.getElementById('mwCadence').value;
    var budget = parseInt(document.getElementById('mwBudget').value) || 4000;
    if (!title || !goal) return toast('Title and goal are required');
    var r = await fetch(API + '/api/missions', {
      method: 'POST', headers: H(),
      body: JSON.stringify({ agentId: currentAgent(), title: title, goal: goal, cadence: cadence, maxTokensPerRun: budget, enabled: false })
    });
    if (r.ok) { toast('Mission created (paused) — enable it when ready'); refresh(); }
    else { var d = await r.json().catch(function () { return {}; }); toast('Could not create mission: ' + (d.error || r.status)); }
  }

  async function decide(execId, action, btn) {
    btn.disabled = true; btn.textContent = action === 'approve' ? 'Approving…' : 'Rejecting…';
    try {
      var r = await fetch(API + '/api/executions/' + execId + '/' + action, { method: 'POST', headers: H(), body: '{}' });
      var d = await r.json();
      toast(r.ok ? (action === 'approve' ? 'Approved — the agent is continuing' : 'Rejected') : 'Failed: ' + (d.error || r.status));
    } catch (e) { toast('Failed: ' + e.message); }
    refresh();
  }

  function init() {
    if (!document.getElementById('sideNav')) return; // not a FinChat page
    // Track agent selection: wrap the page's selectAgent if present
    if (typeof window.selectAgent === 'function' && !window.selectAgent.__mwWrapped) {
      var orig = window.selectAgent;
      var wrapped = function (id) { state.agent = id; var r = orig.apply(this, arguments); render(); return r; };
      wrapped.__mwWrapped = true;
      window.selectAgent = wrapped;
    }
    refresh();
    // Egress guard: only refresh while the tab is visible.
    setInterval(() => { if (!document.hidden) refresh(); }, 60000); // keep approvals + next-run times fresh
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
