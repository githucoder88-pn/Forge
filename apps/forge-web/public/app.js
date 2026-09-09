/* Forge web client shell: navigation, sessions, live state, palette. */
'use strict';

(function () {
  const $ = (sel) => document.querySelector(sel);
  const esc = window.forgeEsc;
  const shortId = window.forgeShortId;
  const fmtTime = window.forgeFmtTime;

  const base = window.location.origin;
  const qs = new URLSearchParams(window.location.search);
  const qsToken = qs.get('token');
  if (qsToken) localStorage.setItem('forge.token', qsToken);
  const api = new window.ForgeApi(base, qsToken || localStorage.getItem('forge.token') || null);

  const state = {
    sessionId: localStorage.getItem('forge.sessionId') || null,
    sessions: [],
    agents: [],
    tasks: [],
    teams: [],
    messages: [],
    events: [],
    approvals: [],
    files: [],
    projectDir: null,
    branch: null,
    view: 'project',
    connected: false,
  };

  const ctx = {
    api, state,
    toast,
    reconnect: connectEvents,
    onMessages: null,
    onEvents: null,
    termFeed: null,
    goto(view) { setView(view); },
  };

  let eventConn = null;
  let renderTimer = null;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), 3500);
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderActivity();
      if (typeof ctx.onEvents === 'function' && state.view === 'events') ctx.onEvents();
    }, 150);
  }

  /* ------------------------------------------------------------ sessions --- */
  async function loadSessions() {
    const picker = $('#session-picker');
    try {
      state.sessions = await api.sessionList();
    } catch (err) {
      toast('Failed to reach server: ' + err.message);
      state.sessions = [];
    }
    // Prefer: stored → most recently updated active → first.
    const ids = new Set(state.sessions.map((s) => s.id));
    if (!state.sessionId || !ids.has(state.sessionId)) {
      const active = state.sessions.filter((s) => s.status === 'active').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      state.sessionId = (active[0] || state.sessions[0] || {}).id || null;
      if (state.sessionId) localStorage.setItem('forge.sessionId', state.sessionId);
    }
    picker.innerHTML = state.sessions.map((s) =>
      '<option value="' + s.id + '"' + (s.id === state.sessionId ? ' selected' : '') + '>'
      + esc(s.name) + ' (' + shortId(s.id) + ')' + (s.simulated ? ' [DEMO]' : '') + '</option>').join('')
      || '<option value="">(no sessions)</option>';
    updateSessionChrome();
  }

  function updateSessionChrome() {
    const s = state.sessions.find((x) => x.id === state.sessionId);
    state.projectDir = s ? s.projectDir : null;
    $('#project-label').textContent = s ? (s.name + ' — ' + s.projectDir) : 'No session';
    const banner = $('#demo-banner');
    if (s && s.simulated) {
      banner.classList.remove('hidden');
      $('#demo-sub').textContent = 'Session: ' + s.name;
    } else {
      banner.classList.add('hidden');
    }
  }

  async function newSession() {
    const name = prompt('Session name:', 'work');
    if (name === null) return;
    try {
      const s = await api.sessionCreate({ name: name || undefined });
      state.sessionId = s.id;
      localStorage.setItem('forge.sessionId', s.id);
      await loadSessions();
      await refreshAll();
      toast('Session created: ' + s.id);
    } catch (err) { toast('Error: ' + err.message); }
  }

  /* -------------------------------------------------------------- state --- */
  async function refreshAll() {
    if (!state.sessionId) return;
    try {
      const [agents, tasks, teams, messages, approvals, health] = await Promise.all([
        api.agentList(state.sessionId).catch(() => []),
        api.taskList(state.sessionId).catch(() => []),
        api.teamList(state.sessionId).catch(() => []),
        api.conversation({ sessionId: state.sessionId, limit: 200 }).catch(() => []),
        api.approvalList().catch(() => []),
        api.health().catch(() => null),
      ]);
      state.agents = agents;
      state.tasks = tasks;
      state.teams = teams;
      state.messages = messages;
      state.approvals = approvals;
      if (health) $('#ctx-label').textContent = 'events #' + health.eventSeq;
      renderActivity();
      updateModelChip();
      renderApprovals();
    } catch (e) { /* stay on last known state */ }
  }

  async function updateModelChip() {
    try {
      const st = await api.modelStatus();
      const entries = Object.entries(st.providers || {});
      const down = entries.filter(([, p]) => p.health === 'offline').length;
      $('#model-chip').textContent = entries.length === 0
        ? 'model: none configured'
        : 'model: ' + entries.length + ' provider' + (entries.length > 1 ? 's' : '') + (down ? ' (' + down + ' offline)' : '');
    } catch (e) { $('#model-chip').textContent = 'model: ?'; }
  }

  async function updateBranch() {
    try {
      const res = await api.toolInvoke('git_branch', {}, { sessionId: state.sessionId });
      state.branch = res.ok ? res.result.current : null;
      $('#branch-label').textContent = state.branch ? '⎇ ' + state.branch : '';
    } catch (e) { $('#branch-label').textContent = ''; }
  }

  /* ------------------------------------------------------------ activity --- */
  function renderActivity() {
    $('#agents-count').textContent = '(' + state.agents.length + ')';
    $('#activity-agents').innerHTML = state.agents.slice(0, 8).map((a) =>
      '<div class="mini-row" data-goto="agents"><span><b>' + esc(a.name) + '</b></span>'
      + '<span class="st st-' + esc(a.state) + '">' + esc(a.state) + (a.progress !== null ? ' ' + a.progress + '%' : '') + '</span></div>').join('')
      || '<div class="empty">none</div>';
    const open = state.tasks.filter((t) => !['completed', 'failed', 'cancelled'].includes(t.status));
    $('#tasks-count').textContent = '(' + open.length + '/' + state.tasks.length + ')';
    $('#activity-tasks').innerHTML = open.slice(0, 8).map((t) =>
      '<div class="mini-row" data-goto="tasks"><span>' + esc(t.title.slice(0, 28)) + '</span>'
      + '<span class="st st-' + esc(t.status) + '">' + esc(t.status) + '</span></div>').join('')
      || '<div class="empty">none open</div>';
    $('#approvals-count').textContent = '(' + state.approvals.length + ')';
    $('#activity-approvals').innerHTML = state.approvals.slice(0, 5).map((a) =>
      '<div class="mini-row"><span>' + esc(a.summary.slice(0, 30)) + '</span><span class="st st-' + esc(a.risk) + '">' + esc(a.risk) + '</span></div>').join('')
      || '<div class="empty">none</div>';
    document.querySelectorAll('[data-goto]').forEach((n) => { n.onclick = () => setView(n.dataset.goto); });
  }

  function renderActivityEvents() {
    $('#activity-events').innerHTML = state.events.slice(-8).reverse().map((e) =>
      '<div>' + fmtTime(e.ts) + ' ' + esc(e.type) + '</div>').join('');
  }

  /* ------------------------------------------------------------ approvals --- */
  function renderApprovals() {
    const banner = $('#approval-banner');
    if (!state.approvals.length) { banner.classList.add('hidden'); banner.innerHTML = ''; return; }
    const a = state.approvals[0];
    banner.classList.remove('hidden');
    banner.innerHTML = '<b>Approval needed</b><span class="mono">' + esc(a.summary).slice(0, 160) + '</span><span>[' + esc(a.risk) + ']</span>'
      + '<button class="btn small primary" id="ap-ok">Approve</button><button class="btn small danger" id="ap-no">Deny</button>'
      + (state.approvals.length > 1 ? '<span>+' + (state.approvals.length - 1) + ' more</span>' : '');
    $('#ap-ok').onclick = () => resolveApproval(a.id, true);
    $('#ap-no').onclick = () => resolveApproval(a.id, false);
  }

  async function resolveApproval(id, approved) {
    try {
      await api.approvalResolve(id, approved);
      state.approvals = await api.approvalList();
      renderApprovals();
      renderActivity();
    } catch (err) { toast('Error: ' + err.message); }
  }

  /* --------------------------------------------------------------- events --- */
  function connectEvents() {
    if (eventConn) eventConn.disconnect();
    eventConn = api.connectEvents(state.sessionId ? { sessionId: state.sessionId } : {}, {
      onEvent,
      onStatus(s) {
        state.connected = s === 'connected';
        const c = $('#conn-status');
        c.textContent = s === 'connected' ? '● live' : s;
        c.className = 'conn ' + (s === 'connected' ? 'ok' : 'bad');
      },
    });
  }

  function appendBottom(tabId, text) {
    const el = $(tabId);
    const div = document.createElement('div');
    div.textContent = text;
    el.appendChild(div);
    while (el.children.length > 400) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  function onEvent(e) {
    state.events.push(e);
    if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
    appendBottom('#bottom-events', fmtTime(e.ts) + ' #' + e.seq + ' ' + e.type + ' ' + JSON.stringify(e.data).slice(0, 220));
    renderActivityEvents();
    const d = e.data || {};
    // Patch local state from authoritative events (no polling).
    if (e.type === 'agent.message.sent' && d.id) {
      state.messages.push({ id: d.id, from: d.from, to: d.to, type: d.type, subject: d.subject, body: d.body, ts: e.ts });
      if (state.view === 'messages' && typeof ctx.onMessages === 'function') ctx.onMessages();
    }
    if (e.type === 'tool.output' && state.view === 'terminal' && typeof ctx.termFeed === 'function') {
      ctx.termFeed(d.text || '');
    }
    if ((e.type === 'tool.completed' || e.type === 'tool.failed') && d.tool === 'shell') {
      appendBottom('#bottom-output', '$ ' + (d.tool || '') + ' → ' + (e.type === 'tool.completed' ? 'ok' : 'FAILED') + ' (' + d.durationMs + 'ms)');
    }
    if (e.type === 'approval.requested' || e.type === 'approval.resolved') {
      api.approvalList().then((a) => { state.approvals = a; renderApprovals(); renderActivity(); }).catch(() => {});
    }
    if (e.type.startsWith('agent.') || e.type.startsWith('task.') || e.type.startsWith('team.')) {
      scheduleRender();
      // Refresh the active view's data on a slow cadence while things change.
      if (!onEvent._t) {
        onEvent._t = setTimeout(async () => {
          onEvent._t = null;
          try {
            if (state.sessionId) {
              state.agents = await api.agentList(state.sessionId);
              state.tasks = await api.taskList(state.sessionId);
              renderActivity();
            }
          } catch (err) { /* ignore */ }
        }, 2000);
      }
    }
    if (e.type.startsWith('model.')) scheduleRender();
  }

  /* ---------------------------------------------------------------- views --- */
  async function setView(view) {
    state.view = view;
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
    ctx.onMessages = null;
    ctx.onEvents = null;
    ctx.termFeed = null;
    const main = $('#main');
    main.innerHTML = '<div class="empty">Loading…</div>';
    if (!state.sessionId && view !== 'settings') {
      main.innerHTML = '<div class="empty">No session selected. Create one with + Session.</div>';
      return;
    }
    try {
      const renderer = window.ForgeViews[view];
      if (!renderer) { main.innerHTML = '<div class="empty">Unknown view.</div>'; return; }
      await renderer(main, ctx);
    } catch (err) {
      main.innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>';
    }
  }

  /* -------------------------------------------------------------- palette --- */
  const COMMANDS = [
    { name: 'Go: Project', hint: 'g p', run: () => setView('project') },
    { name: 'Go: Agents', hint: 'g a', run: () => setView('agents') },
    { name: 'Go: Tasks', hint: 'g t', run: () => setView('tasks') },
    { name: 'Go: Teams', hint: 'g e', run: () => setView('teams') },
    { name: 'Go: Messages', hint: 'g m', run: () => setView('messages') },
    { name: 'Go: Git', hint: 'g g', run: () => setView('git') },
    { name: 'Go: Terminal', hint: 'g `', run: () => setView('terminal') },
    { name: 'Go: Models', hint: 'g o', run: () => setView('models') },
    { name: 'Go: Events', hint: 'g v', run: () => setView('events') },
    { name: 'Go: Settings', hint: 'g s', run: () => setView('settings') },
    { name: 'Run goal (new agent, detached)', hint: 'run', run: runGoalPalette },
    { name: 'Plan goal (no execution)', hint: 'plan', run: planPalette },
    { name: 'New session', run: newSession },
    { name: 'Create checkpoint', run: checkpointPalette },
    { name: 'Refresh branch', run: updateBranch },
  ];

  async function runGoalPalette() {
    const goal = prompt('Goal:');
    if (!goal) return;
    try {
      const res = await api.rpc('runtime.run', { sessionId: state.sessionId, goal, plan: true });
      toast('Run accepted for session ' + shortId(res.sessionId) + ' — watch Events');
    } catch (err) { toast('Error: ' + err.message); }
  }

  async function planPalette() {
    const goal = prompt('Goal to plan:');
    if (!goal) return;
    try {
      const tasks = await api.rpc('runtime.plan', { sessionId: state.sessionId, goal });
      toast('Planned ' + tasks.length + ' tasks');
      setView('tasks');
    } catch (err) { toast('Error: ' + err.message); }
  }

  async function checkpointPalette() {
    const label = prompt('Checkpoint label:');
    if (!label || !state.sessionId) return;
    try {
      const c = await api.checkpointCreate(state.sessionId, label);
      toast('Checkpoint created: ' + c.id);
    } catch (err) { toast('Error: ' + err.message); }
  }

  function openPalette() {
    $('#palette').classList.remove('hidden');
    const input = $('#palette-input');
    input.value = '';
    renderPalette('');
    setTimeout(() => input.focus(), 20);
  }
  function closePalette() {
    $('#palette').classList.add('hidden');
  }
  function renderPalette(q) {
    const list = $('#palette-list');
    const items = COMMANDS.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
    list.innerHTML = items.map((c, i) =>
      '<div class="palette-item' + (i === 0 ? ' sel' : '') + '" data-i="' + COMMANDS.indexOf(c) + '">' + esc(c.name) + (c.hint ? '<span class="hint">' + esc(c.hint) + '</span>' : '') + '</div>').join('')
      || '<div class="empty">No matching command.</div>';
    list.querySelectorAll('.palette-item').forEach((n) => {
      n.onclick = () => { closePalette(); COMMANDS[Number(n.dataset.i)].run(); };
    });
  }

  /* ------------------------------------------------------------------ boot --- */
  async function boot() {
    document.querySelectorAll('.nav-item').forEach((n) => { n.onclick = () => setView(n.dataset.view); });
    document.querySelectorAll('.tab').forEach((t) => {
      t.onclick = () => {
        document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
        $('#bottom-events').classList.toggle('hidden', t.dataset.tab !== 'events');
        $('#bottom-output').classList.toggle('hidden', t.dataset.tab !== 'output');
      };
    });
    $('#btn-palette').onclick = openPalette;
    $('#btn-new-session').onclick = newSession;
    $('#session-picker').onchange = async (e) => {
      state.sessionId = e.target.value || null;
      localStorage.setItem('forge.sessionId', state.sessionId || '');
      updateSessionChrome();
      connectEvents();
      await refreshAll();
      await setView(state.view);
    };
    $('#palette-input').oninput = (e) => renderPalette(e.target.value);
    $('#palette-input').onkeydown = (e) => {
      if (e.key === 'Enter') {
        const first = $('#palette-list .palette-item.sel');
        if (first) { closePalette(); COMMANDS[Number(first.dataset.i)].run(); }
      }
    };
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
      if (e.key === 'Escape') closePalette();
    });

    try {
      await api.health();
    } catch (err) {
      $('#main').innerHTML = '<div class="empty">Cannot reach the Forge server at ' + esc(base) + '. Start it with <b>forge serve</b>, then reload.</div>';
      $('#conn-status').textContent = '● offline';
      $('#conn-status').className = 'conn bad';
      return;
    }
    await loadSessions();
    connectEvents();
    await refreshAll();
    await updateBranch();
    await setView('project');
    // Keep branch + provider chip fresh on git/model events only (no polling).
    setInterval(updateModelChip, 30000);
  }

  boot();
})();
