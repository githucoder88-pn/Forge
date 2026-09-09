/* Forge view renderers. Every value comes from RPC or the event stream. */
'use strict';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shortId(id) {
  if (!id) return '-';
  const p = String(id).split('_');
  return p.length > 1 ? p[0] + '_' + p[1].slice(-6) : id;
}
function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return isNaN(d) ? ts : d.toLocaleTimeString('en-GB', { hour12: false });
}
function statePill(s) {
  return '<span class="st-' + esc(s || 'unknown') + '">' + esc(s || 'unknown') + '</span>';
}
function progressBar(p) {
  if (p === null || p === undefined) return '<span style="color:var(--faint)">no estimate</span>';
  return '<div class="progress"><div style="width:' + Math.max(0, Math.min(100, p)) + '%"></div></div>';
}
function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

const Views = {};

/* --------------------------------------------------------------- project --- */
Views.project = async function (root, ctx) {
  const { api, state } = ctx;
  root.innerHTML = '<h2>Project</h2><div class="toolbar">'
    + '<input id="pj-search" class="input" placeholder="Search files… (Enter)" style="width:280px">'
    + '<button class="btn small" id="pj-refresh">Refresh</button>'
    + '<span style="color:var(--faint);font-size:11px" id="pj-count"></span>'
    + '</div><div class="cols"><div class="col-tree tree" id="pj-tree"></div>'
    + '<div class="col-main"><div id="pj-file"></div></div></div>';

  async function loadTree() {
    const tree = root.querySelector('#pj-tree');
    tree.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const res = await api.rpc('workspace.list', { sessionId: state.sessionId, path: '.', recursive: true, maxEntries: 2000 });
      state.files = res.entries || [];
      root.querySelector('#pj-count').textContent = state.files.length + ' entries';
      tree.innerHTML = '';
      for (const e of state.files) {
        const depth = (e.path.match(/\//g) || []).length;
        const row = el('<div class="tree-row' + (e.type === 'dir' ? ' dir' : '') + '">' + '&nbsp;'.repeat(depth * 2) + esc(e.name) + '</div>');
        row.title = e.path;
        if (e.type !== 'dir') row.onclick = () => openFile(e.path);
        tree.appendChild(row);
      }
      if (state.files.length === 0) tree.innerHTML = '<div class="empty">Empty workspace.</div>';
    } catch (err) { tree.innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
  }

  async function openFile(path) {
    const pane = root.querySelector('#pj-file');
    pane.innerHTML = '<div class="empty">Loading ' + esc(path) + '…</div>';
    try {
      const [file, hist] = await Promise.all([
        api.rpc('workspace.read', { sessionId: state.sessionId, path }),
        api.rpc('workspace.history', { sessionId: state.sessionId, path }).catch(() => ({ history: [] })),
      ]);
      const content = file.content || '';
      const histRows = (hist.history || []).map((h) =>
        '<tr><td>' + fmtTime(h.ts) + '</td><td>' + esc(h.op) + '</td><td>' + esc(h.agentId ? shortId(h.agentId) : '-') + '</td><td>' + esc(h.taskId ? shortId(h.taskId) : '-') + '</td></tr>').join('');
      pane.innerHTML = '<h3>' + esc(path) + ' <span style="font-weight:400">(' + content.length + ' chars)</span></h3>'
        + '<pre class="code">' + esc(content.slice(0, 60000)) + (content.length > 60000 ? '\n…[truncated]…' : '') + '</pre>'
        + '<h3>History — who changed this file and why</h3>'
        + (histRows ? '<table class="grid"><tr><th>time</th><th>op</th><th>agent</th><th>task</th></tr>' + histRows + '</table>' : '<div class="empty">No recorded changes.</div>');
    } catch (err) { pane.innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
  }

  async function search(q) {
    const pane = root.querySelector('#pj-file');
    pane.innerHTML = '<div class="empty">Searching…</div>';
    try {
      const res = await api.rpc('workspace.search', { sessionId: state.sessionId, pattern: q, maxResults: 200 });
      const rows = (res.matches || []).map((m) =>
        '<tr data-path="' + esc(m.path) + '"><td class="mono">' + esc(m.path) + ':' + m.line + '</td><td class="mono">' + esc(m.text) + '</td></tr>').join('');
      pane.innerHTML = '<h3>Search: ' + esc(q) + ' (' + (res.matches || []).length + ' matches)</h3>'
        + (rows ? '<table class="grid"><tr><th>location</th><th>line</th></tr>' + rows + '</table>' : '<div class="empty">No matches.</div>');
      pane.querySelectorAll('tr[data-path]').forEach((tr) => { tr.onclick = () => openFile(tr.dataset.path); });
    } catch (err) { pane.innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
  }

  root.querySelector('#pj-refresh').onclick = loadTree;
  root.querySelector('#pj-search').onkeydown = (e) => { if (e.key === 'Enter') search(e.target.value); };
  await loadTree();
  try {
    const inst = await api.rpc('workspace.instructions', { sessionId: state.sessionId, forDir: '.' });
    if (inst.files && inst.files.length) {
      const pane = root.querySelector('#pj-file');
      pane.innerHTML = '<h3>Project instructions (root → nested precedence)</h3>' + inst.files.map((f) =>
        '<div class="card"><b>' + esc(f.path) + '</b><pre class="code" style="max-height:220px">' + esc(f.content.slice(0, 4000)) + '</pre></div>').join('');
    }
  } catch (e) { /* instructions unavailable */ }
};

/* ---------------------------------------------------------------- agents --- */
Views.agents = async function (root, ctx) {
  const { api, state } = ctx;
  root.innerHTML = '<h2>Agents</h2><div class="toolbar">'
    + '<button class="btn small" id="ag-refresh">Refresh</button>'
    + '<button class="btn small" id="ag-new">+ New agent</button>'
    + '<button class="btn small primary" id="ag-run">Run goal…</button>'
    + '</div><div id="ag-list"></div><div id="ag-detail"></div>';

  async function load() {
    const list = root.querySelector('#ag-list');
    try {
      state.agents = await api.agentList(state.sessionId);
      if (!state.agents.length) {
        list.innerHTML = '<div class="empty">No agents running.<br><br><button class="btn" id="ag-empty-run">Run a goal</button></div>';
        const b = list.querySelector('#ag-empty-run');
        if (b) b.onclick = runGoal;
        return;
      }
      const rows = state.agents.map((a) =>
        '<tr data-id="' + a.id + '"><td class="mono">' + shortId(a.id) + '</td><td><b>' + esc(a.name) + '</b>' + (a.simulated ? ' <span class="msg-type">SIM</span>' : '') + '</td><td>' + esc(a.role) + '</td><td>' + statePill(a.state) + '</td>'
        + '<td>' + (a.progress === null ? '-' : a.progress + '%') + '</td><td>' + esc((a.currentAction || '').slice(0, 50)) + '</td>'
        + '<td class="mono">' + (a.metrics.inputTokens || 0) + '/' + (a.metrics.outputTokens || 0) + '</td></tr>').join('');
      list.innerHTML = '<table class="grid"><tr><th>id</th><th>name</th><th>role</th><th>state</th><th>progress</th><th>action</th><th>tok</th></tr>' + rows + '</table>';
      list.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => inspect(tr.dataset.id); });
    } catch (err) { list.innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
  }

  async function inspect(id) {
    const d = root.querySelector('#ag-detail');
    d.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const a = await api.agentGet(id);
      const plan = (a.plan || []).map((s) => '<div>[' + (s.done ? 'x' : ' ') + '] ' + esc(s.title) + '</div>').join('');
      const tail = (a.transcriptTail || []).map((m) => '<div class="msg"><div class="msg-head"><b>' + esc(m.role) + '</b></div><div class="msg-body">' + esc((m.content || '').slice(0, 1200)) + '</div></div>').join('');
      d.innerHTML = '<div class="card"><h3>' + esc(a.name) + ' <span style="font-weight:400">' + esc(a.role) + ' · ' + shortId(a.id) + '</span></h3>'
        + '<div class="kv"><span class="k">state</span><span>' + statePill(a.state) + '</span>'
        + '<span class="k">model</span><span class="mono">' + esc(a.model ? a.model.provider + ':' + a.model.model : '(routed)') + '</span>'
        + '<span class="k">task</span><span class="mono">' + esc(a.currentTaskId ? shortId(a.currentTaskId) : '-') + '</span>'
        + '<span class="k">autonomy</span><span>' + esc(a.autonomy) + ' / ' + esc(a.policy) + '</span>'
        + '<span class="k">children</span><span class="mono">' + (a.children || []).map(shortId).join(', ') + '</span>'
        + '<span class="k">metrics</span><span class="mono">' + esc(JSON.stringify(a.metrics)) + '</span></div>'
        + (a.lastError ? '<div style="color:var(--red);margin-top:6px">' + esc(a.lastError) + '</div>' : '')
        + '<div class="toolbar" style="margin-top:8px">'
        + '<button class="btn small" data-act="pause">Pause</button><button class="btn small" data-act="resume">Resume</button>'
        + '<button class="btn small" data-act="cancel">Cancel</button><button class="btn small" data-act="retry">Retry</button>'
        + '<button class="btn small" data-act="spawn">Spawn subagent…</button></div>'
        + (plan ? '<h3>Plan</h3>' + plan : '')
        + (tail ? '<h3>Recent transcript</h3>' + tail : '')
        + '<h3>Message this agent</h3><div class="toolbar"><input class="input" id="ag-msg" placeholder="Message body…" style="flex:1">'
        + '<button class="btn small" data-act="send">Send</button></div></div>';
      d.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = async () => {
          const act = b.dataset.act;
          try {
            if (act === 'pause') await api.agentPause(id);
            else if (act === 'resume') await api.agentResume(id);
            else if (act === 'cancel') await api.agentCancel(id);
            else if (act === 'retry') await api.rpc('agent.retry', { agentId: id });
            else if (act === 'spawn') {
              const name = prompt('Subagent name:', 'subagent');
              if (!name) return;
              const goal = prompt('Delegated objective:');
              if (!goal) return;
              await api.agentSpawn(id, { name, goal });
            } else if (act === 'send') {
              const body = d.querySelector('#ag-msg').value;
              if (!body) return;
              await api.messageSend({ from: 'human', to: id, type: 'request', body, sessionId: state.sessionId });
              ctx.toast('Message sent');
            }
            await load();
            await inspect(id);
          } catch (err) { ctx.toast('Error: ' + err.message); }
        };
      });
    } catch (err) { d.innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
  }

  async function runGoal() {
    const goal = prompt('Goal for a new agent:');
    if (!goal) return;
    try {
      const agent = await api.agentCreate({ sessionId: state.sessionId, name: 'agent-' + Date.now().toString(36).slice(-4) });
      await api.agentStart(agent.id, goal);
      ctx.toast('Agent started: ' + agent.id);
      await load();
    } catch (err) { ctx.toast('Error: ' + err.message); }
  }

  root.querySelector('#ag-refresh').onclick = load;
  root.querySelector('#ag-run').onclick = runGoal;
  root.querySelector('#ag-new').onclick = async () => {
    const name = prompt('Agent name:', 'agent');
    if (!name) return;
    try {
      await api.agentCreate({ sessionId: state.sessionId, name });
      await load();
    } catch (err) { ctx.toast('Error: ' + err.message); }
  };
  await load();
};

/* ----------------------------------------------------------------- tasks --- */
Views.tasks = async function (root, ctx) {
  const { api, state } = ctx;
  root.innerHTML = '<h2>Tasks</h2><div class="toolbar">'
    + '<button class="btn small" id="t-refresh">Refresh</button>'
    + '<button class="btn small" id="t-new">+ New task</button>'
    + '<button class="btn small primary" id="t-run">Run all ready</button>'
    + '</div><div id="t-list"></div><div id="t-detail"></div>';

  async function load() {
    const list = root.querySelector('#t-list');
    try {
      state.tasks = await api.taskList(state.sessionId);
      if (!state.tasks.length) {
        list.innerHTML = '<div class="empty">No tasks.<br><br><button class="btn" id="t-empty-new">Create Task</button></div>';
        const b = list.querySelector('#t-empty-new');
        if (b) b.onclick = createTask;
        return;
      }
      const rows = state.tasks.map((t) =>
        '<tr data-id="' + t.id + '"><td class="mono">' + shortId(t.id) + '</td><td><b>' + esc(t.title.slice(0, 60)) + '</b></td><td>' + statePill(t.status) + '</td>'
        + '<td>' + (t.progress === null ? '-' : t.progress + '%') + '</td><td class="mono">' + (t.ownerAgentId ? shortId(t.ownerAgentId) : '-') + '</td>'
        + '<td class="mono">' + (t.dependsOn || []).map(shortId).join(', ') + '</td></tr>').join('');
      list.innerHTML = '<table class="grid"><tr><th>id</th><th>title</th><th>status</th><th>progress</th><th>owner</th><th>depends on</th></tr>' + rows + '</table>';
      list.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => inspect(tr.dataset.id); });
    } catch (err) { list.innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
  }

  async function inspect(id) {
    const d = root.querySelector('#t-detail');
    try {
      const t = await api.taskGet(id);
      state.agents = await api.agentList(state.sessionId).catch(() => state.agents);
      const ownerOpts = '<option value="">(unassigned)</option>' + (state.agents || []).map((a) =>
        '<option value="' + a.id + '"' + (t.ownerAgentId === a.id ? ' selected' : '') + '>' + esc(a.name) + ' (' + shortId(a.id) + ')</option>').join('');
      d.innerHTML = '<div class="card"><h3>' + esc(t.title) + '</h3>'
        + '<div class="kv"><span class="k">id</span><span class="mono">' + t.id + '</span>'
        + '<span class="k">status</span><span>' + statePill(t.status) + '</span>'
        + '<span class="k">priority</span><span>' + t.priority + '</span>'
        + '<span class="k">depends on</span><span class="mono">' + (t.dependsOn || []).join(', ') + '</span>'
        + '<span class="k">retries</span><span>' + t.retries + '/' + t.maxRetries + '</span>'
        + '<span class="k">artifacts</span><span>' + esc((t.artifacts || []).join(', ')) + '</span></div>'
        + (t.description ? '<p>' + esc(t.description).slice(0, 2000) + '</p>' : '')
        + (t.blockedBy ? '<div style="color:var(--red)">Blocked: ' + esc(t.blockedBy) + '</div>' : '')
        + (t.errors || []).map((e) => '<div style="color:var(--red)">Error: ' + esc(e.message).slice(0, 400) + '</div>').join('')
        + '<div class="toolbar" style="margin-top:8px"><label class="lbl">Owner</label><select class="input" id="t-owner">' + ownerOpts + '</select>'
        + '<button class="btn small" data-act="assign">Assign</button>'
        + '<button class="btn small" data-act="cancel">Cancel</button><button class="btn small" data-act="retry">Retry</button></div></div>';
      d.querySelectorAll('[data-act]').forEach((b) => {
        b.onclick = async () => {
          try {
            if (b.dataset.act === 'assign') await api.rpc('task.setOwner', { taskId: id, ownerAgentId: d.querySelector('#t-owner').value || undefined });
            else if (b.dataset.act === 'cancel') await api.rpc('task.cancel', { taskId: id });
            else if (b.dataset.act === 'retry') await api.rpc('task.retry', { taskId: id });
            await load();
            await inspect(id);
          } catch (err) { ctx.toast('Error: ' + err.message); }
        };
      });
    } catch (err) { d.innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
  }

  async function createTask() {
    const title = prompt('Task title:');
    if (!title) return;
    try {
      await api.taskCreate({ sessionId: state.sessionId, title });
      await load();
    } catch (err) { ctx.toast('Error: ' + err.message); }
  }

  root.querySelector('#t-refresh').onclick = load;
  root.querySelector('#t-new').onclick = createTask;
  root.querySelector('#t-run').onclick = async () => {
    try {
      await api.taskRun(state.sessionId);
      ctx.toast('Task run accepted — watch Events');
    } catch (err) { ctx.toast('Error: ' + err.message); }
  };
  await load();
};

/* ----------------------------------------------------------------- teams --- */
Views.teams = async function (root, ctx) {
  const { api, state } = ctx;
  root.innerHTML = '<h2>Teams</h2><div class="toolbar">'
    + '<button class="btn small" id="tm-refresh">Refresh</button>'
    + '<button class="btn small" id="tm-new">+ New team</button>'
    + '</div><div id="tm-list"></div><div id="tm-detail"></div>';

  async function load() {
    const list = root.querySelector('#tm-list');
    try {
      state.teams = await api.teamList(state.sessionId);
      if (!state.teams.length) {
        list.innerHTML = '<div class="empty">No teams.<br><br><button class="btn" id="tm-empty-new">Create Team</button></div>';
        const b = list.querySelector('#tm-empty-new');
        if (b) b.onclick = createTeam;
        return;
      }
      const rows = state.teams.map((t) =>
        '<tr data-id="' + t.id + '"><td class="mono">' + shortId(t.id) + '</td><td><b>' + esc(t.name) + '</b></td>'
        + '<td>' + t.memberIds.length + '</td><td>' + t.taskQueue.length + '</td><td>' + esc((t.sharedGoal || '').slice(0, 60)) + '</td></tr>').join('');
      list.innerHTML = '<table class="grid"><tr><th>id</th><th>name</th><th>members</th><th>queued</th><th>goal</th></tr>' + rows + '</table>';
      list.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => inspect(tr.dataset.id); });
    } catch (err) { list.innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
  }

  async function inspect(id) {
    const d = root.querySelector('#tm-detail');
    try {
      const [t, st] = await Promise.all([api.teamGet(id), api.teamStatus(id)]);
      const members = (st.members || []).map((m) =>
        '<tr><td class="mono">' + shortId(m.agentId) + '</td><td>' + esc(m.role) + '</td><td>' + statePill(m.state) + '</td><td>' + (m.progress === null ? '-' : m.progress + '%') + '</td></tr>').join('');
      const blockers = (st.blockers || []).map((b) => '<div style="color:var(--red)">Blocked ' + esc(b.taskId ? shortId(b.taskId) : '') + ': ' + esc(b.reason) + '</div>').join('');
      d.innerHTML = '<div class="card"><h3>' + esc(t.name) + '</h3>'
        + '<div class="kv"><span class="k">goal</span><span>' + esc(t.sharedGoal || '-') + '</span>'
        + '<span class="k">progress</span><span>' + (st.progress === null ? 'unknown' : st.progress + '%') + ' ' + progressBar(st.progress) + '</span>'
        + '<span class="k">tasks</span><span>' + st.tasks.completed + '/' + st.tasks.total + ' done · ' + st.tasks.running + ' running · ' + st.tasks.blocked + ' blocked · ' + st.tasks.failed + ' failed</span></div>'
        + blockers
        + '<h3>Members</h3><table class="grid"><tr><th>agent</th><th>role</th><th>state</th><th>progress</th></tr>' + members + '</table>'
        + '<div class="toolbar" style="margin-top:8px"><input class="input" id="tm-agent" placeholder="agent id to add" style="width:220px">'
        + '<input class="input" id="tm-role" placeholder="role" style="width:120px"><button class="btn small" id="tm-add">Add member</button></div></div>';
      d.querySelector('#tm-add').onclick = async () => {
        try {
          await api.rpc('team.addMember', { teamId: id, agentId: d.querySelector('#tm-agent').value, role: d.querySelector('#tm-role').value || 'member' });
          await inspect(id);
        } catch (err) { ctx.toast('Error: ' + err.message); }
      };
    } catch (err) { d.innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
  }

  async function createTeam() {
    const name = prompt('Team name:', 'engineering');
    if (!name) return;
    try {
      await api.teamCreate({ sessionId: state.sessionId, name });
      await load();
    } catch (err) { ctx.toast('Error: ' + err.message); }
  }

  root.querySelector('#tm-refresh').onclick = load;
  root.querySelector('#tm-new').onclick = createTeam;
  await load();
};

/* -------------------------------------------------------------- messages --- */
Views.messages = async function (root, ctx) {
  const { api, state } = ctx;
  root.innerHTML = '<h2>Messages</h2><div class="toolbar">'
    + '<input class="input" id="mg-to" placeholder="to (agent id/name or *)" style="width:200px">'
    + '<input class="input" id="mg-subject" placeholder="subject" style="width:200px">'
    + '<input class="input" id="mg-body" placeholder="message…" style="flex:1">'
    + '<button class="btn small primary" id="mg-send">Send</button>'
    + '</div><div id="mg-list"></div>';

  function render() {
    const list = root.querySelector('#mg-list');
    const msgs = state.messages || [];
    if (!msgs.length) { list.innerHTML = '<div class="empty">No messages yet.</div>'; return; }
    list.innerHTML = msgs.map((m) =>
      '<div class="msg"><div class="msg-head">' + fmtTime(m.ts) + ' <b>' + esc(String(m.from).slice(0, 24)) + '</b> → ' + esc(String(m.to).slice(0, 24))
      + '<span class="msg-type">' + esc(m.type) + '</span>' + (m.subject ? ' ' + esc(m.subject) : '') + '</div>'
      + '<div class="msg-body">' + esc(m.body) + '</div></div>').join('');
  }
  ctx.onMessages = render;
  root.querySelector('#mg-send').onclick = async () => {
    const to = root.querySelector('#mg-to').value || '*';
    const body = root.querySelector('#mg-body').value;
    if (!body) return;
    try {
      await api.messageSend({ from: 'human', to, type: to === '*' ? 'broadcast' : 'request', subject: root.querySelector('#mg-subject').value || undefined, body, sessionId: state.sessionId });
      root.querySelector('#mg-body').value = '';
    } catch (err) { ctx.toast('Error: ' + err.message); }
  };
  try {
    state.messages = await api.conversation({ sessionId: state.sessionId, limit: 200 });
  } catch (err) { state.messages = []; }
  render();
};

/* ------------------------------------------------------------------- git --- */
Views.git = async function (root, ctx) {
  const { api, state } = ctx;
  root.innerHTML = '<h2>Git</h2><div class="toolbar"><button class="btn small" id="g-refresh">Refresh</button></div>'
    + '<div id="g-body"><div class="empty">Loading…</div></div>'
    + '<h3>Commit staged changes</h3><div class="toolbar"><input class="input" id="g-msg" placeholder="commit message" style="flex:1">'
    + '<button class="btn small" id="g-commit">Commit</button></div>';

  function renderDiff(diff) {
    return esc(diff).split('\n').map((line) => {
      if (line.startsWith('+') && !line.startsWith('+++')) return '<div class="diff-add">' + esc(line) + '</div>';
      if (line.startsWith('-') && !line.startsWith('---')) return '<div class="diff-del">' + esc(line) + '</div>';
      if (line.startsWith('@@') || line.startsWith('diff --git')) return '<div class="diff-hunk">' + esc(line) + '</div>';
      return '<div>' + esc(line) + '</div>';
    }).join('');
  }

  async function load() {
    const body = root.querySelector('#g-body');
    try {
      const [status, log, diff] = await Promise.all([
        api.toolInvoke('git_status', {}, { sessionId: state.sessionId }),
        api.toolInvoke('git_log', { limit: 15 }, { sessionId: state.sessionId }),
        api.toolInvoke('git_diff', {}, { sessionId: state.sessionId }),
      ]);
      const st = status.ok ? status.result : null;
      const lg = log.ok ? log.result.log : '(git log unavailable)';
      const df = diff.ok ? diff.result.diff : '';
      body.innerHTML = '<div class="kv"><span class="k">branch</span><span class="mono">' + esc((st && st.branch) || '-') + '</span></div>'
        + '<h3>Status</h3><pre class="code" style="max-height:160px">' + esc((st && st.status) || '(clean or unavailable)') + '</pre>'
        + '<h3>Uncommitted diff</h3>' + (df ? '<pre class="code">' + renderDiff(df.slice(0, 60000)) + '</pre>' : '<div class="empty">No uncommitted changes.</div>')
        + '<h3>History</h3><pre class="code" style="max-height:220px">' + esc(lg) + '</pre>';
    } catch (err) { body.innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
  }

  root.querySelector('#g-refresh').onclick = load;
  root.querySelector('#g-commit').onclick = async () => {
    const msg = root.querySelector('#g-msg').value;
    if (!msg) { ctx.toast('Enter a commit message'); return; }
    try {
      const out = await api.toolInvoke('git_commit', { message: msg }, { sessionId: state.sessionId });
      if (!out.ok) throw new Error(out.error.message);
      ctx.toast('Committed ' + out.result.head.slice(0, 8));
      root.querySelector('#g-msg').value = '';
      await load();
    } catch (err) { ctx.toast('Error: ' + err.message); }
  };
  await load();
};

/* -------------------------------------------------------------- terminal --- */
Views.terminal = async function (root, ctx) {
  root.innerHTML = '<h2>Terminal <span style="font-weight:400;font-size:11px;color:var(--faint)">user shell · workspace root · risky commands need approval</span></h2>'
    + '<div class="term-out" id="tm-out">$ ready — commands run via the Core shell tool.\n</div>'
    + '<div class="term-row"><input class="input" id="tm-in" placeholder="command…" autocomplete="off"><button class="btn small primary" id="tm-run">Run</button></div>';

  const out = root.querySelector('#tm-out');
  const input = root.querySelector('#tm-in');
  const hist = JSON.parse(localStorage.getItem('forge.termHist') || '[]');
  let histIdx = hist.length;

  ctx.termFeed = (text) => {
    out.textContent += text;
    out.scrollTop = out.scrollHeight;
  };

  async function run() {
    const command = input.value.trim();
    if (!command) return;
    hist.push(command);
    localStorage.setItem('forge.termHist', JSON.stringify(hist.slice(-100)));
    histIdx = hist.length;
    input.value = '';
    out.textContent += '\n$ ' + command + '\n';
    try {
      const res = await ctx.api.toolInvoke('shell', { command }, { sessionId: ctx.state.sessionId });
      if (!res.ok) out.textContent += '[exit: FAILED ' + res.error.code + '] ' + res.error.message + '\n';
      else {
        if (res.result.stdout) out.textContent += res.result.stdout + (res.result.stdout.endsWith('\n') ? '' : '\n');
        if (res.result.stderr) out.textContent += res.result.stderr + (res.result.stderr.endsWith('\n') ? '' : '\n');
        out.textContent += '[exit ' + res.result.exitCode + ' · ' + res.result.durationMs + 'ms]\n';
      }
    } catch (err) { out.textContent += 'Error: ' + err.message + '\n'; }
    out.scrollTop = out.scrollHeight;
  }

  root.querySelector('#tm-run').onclick = run;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') run();
    else if (e.key === 'ArrowUp') { if (histIdx > 0) input.value = hist[--histIdx] || ''; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { if (histIdx < hist.length) input.value = hist[++histIdx] || ''; e.preventDefault(); }
  };
  setTimeout(() => input.focus(), 50);
};

/* ---------------------------------------------------------------- models --- */
Views.models = async function (root, ctx) {
  const { api } = ctx;
  root.innerHTML = '<h2>Models</h2><div class="toolbar"><button class="btn small" id="m-refresh">Refresh health</button></div><div id="m-body"></div>';

  async function load(refresh) {
    const body = root.querySelector('#m-body');
    try {
      if (refresh) await api.rpc('model.refresh', {});
      const st = await api.modelStatus();
      const rows = Object.entries(st.providers || {}).map(([id, p]) =>
        '<tr><td><b>' + esc(id) + '</b></td><td>' + statePill(p.health) + '</td><td>' + p.requests + '</td>'
        + '<td class="mono">' + p.tokensIn + '/' + p.tokensOut + '</td><td>' + (p.latencyEwma ? Math.round(p.latencyEwma) + 'ms' : '-') + '</td>'
        + '<td>' + esc((p.lastError || '').slice(0, 80)) + '</td></tr>').join('');
      body.innerHTML = '<div class="kv"><span class="k">strategy</span><span>' + esc((st.routing && st.routing.strategy) || '-') + '</span>'
        + '<span class="k">fallback</span><span>' + ((st.routing && st.routing.fallback === false) ? 'off' : 'on') + '</span></div>'
        + (rows ? '<table class="grid" style="margin-top:8px"><tr><th>provider</th><th>health</th><th>reqs</th><th>tok in/out</th><th>latency</th><th>last error</th></tr>' + rows + '</table>'
          : '<div class="empty">No providers configured. Set an API key (e.g. OPENAI_API_KEY) or start Ollama / LM Studio, then restart the server.</div>');
    } catch (err) { body.innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }
  }
  root.querySelector('#m-refresh').onclick = () => load(true);
  await load(false);
};

/* ----------------------------------------------------------------- tools --- */
Views.tools = async function (root, ctx) {
  const { api, state } = ctx;
  root.innerHTML = '<h2>Tools</h2><div id="tl-list"></div>'
    + '<h3>Invoke</h3><div class="toolbar"><select class="input" id="tl-name"></select></div>'
    + '<label class="lbl">Input (JSON)</label><textarea class="input" id="tl-input" rows="4" style="width:100%">{}</textarea>'
    + '<div class="toolbar" style="margin-top:8px"><button class="btn small primary" id="tl-run">Invoke</button></div>'
    + '<pre class="code" id="tl-out">—</pre>';

  try {
    const tools = await api.toolList();
    root.querySelector('#tl-list').innerHTML = '<table class="grid"><tr><th>tool</th><th>description</th></tr>'
      + tools.map((t) => '<tr><td class="mono"><b>' + esc(t.name) + '</b></td><td>' + esc(t.description) + '</td></tr>').join('') + '</table>';
    const sel = root.querySelector('#tl-name');
    sel.innerHTML = tools.map((t) => '<option>' + esc(t.name) + '</option>').join('');
  } catch (err) { root.querySelector('#tl-list').innerHTML = '<div class="empty">Error: ' + esc(err.message) + '</div>'; }

  root.querySelector('#tl-run').onclick = async () => {
    const out = root.querySelector('#tl-out');
    let input = {};
    try { input = JSON.parse(root.querySelector('#tl-input').value || '{}'); }
    catch { out.textContent = 'Invalid JSON input'; return; }
    out.textContent = 'running…';
    try {
      const res = await api.toolInvoke(root.querySelector('#tl-name').value, input, { sessionId: state.sessionId });
      out.textContent = JSON.stringify(res, null, 2).slice(0, 20000);
    } catch (err) { out.textContent = 'Error: ' + err.message; }
  };
};

/* ---------------------------------------------------------------- memory --- */
Views.memory = async function (root, ctx) {
  const { api, state } = ctx;
  root.innerHTML = '<h2>Memory</h2><div class="toolbar">'
    + '<input class="input" id="mm-q" placeholder="search…" style="width:260px">'
    + '<button class="btn small" id="mm-search">Search</button></div><div id="mm-list"></div>'
    + '<h3>Remember</h3><div class="toolbar"><select class="input" id="mm-scope"><option>project</option><option>global</option><option>session</option><option>team</option><option>agent</option><option>task</option></select>'
    + '<input class="input" id="mm-key" placeholder="key" style="width:180px"><input class="input" id="mm-val" placeholder="value" style="flex:1">'
    + '<button class="btn small primary" id="mm-put">Save</button></div>';

  function render(entries) {
    const list = root.querySelector('#mm-list');
    if (!entries.length) { list.innerHTML = '<div class="empty">No memory entries.</div>'; return; }
    list.innerHTML = '<table class="grid"><tr><th>scope</th><th>key</th><th>value</th><th>updated</th></tr>'
      + entries.map((e) => '<tr><td>' + esc(e.scope) + ':' + esc(String(e.scopeId).slice(0, 18)) + '</td><td><b>' + esc(e.key) + '</b></td><td>' + esc(String(e.value).slice(0, 200)) + '</td><td>' + fmtTime(e.updatedAt) + '</td></tr>').join('') + '</table>';
  }

  root.querySelector('#mm-search').onclick = async () => {
    try {
      render(await api.rpc('memory.search', { query: root.querySelector('#mm-q').value || '' }));
    } catch (err) { ctx.toast('Error: ' + err.message); }
  };
  root.querySelector('#mm-put').onclick = async () => {
    try {
      const scope = root.querySelector('#mm-scope').value;
      await api.rpc('memory.put', {
        scope, scopeId: scope === 'session' ? state.sessionId : scope === 'global' ? 'global' : state.projectDir || 'project',
        key: root.querySelector('#mm-key').value, value: root.querySelector('#mm-val').value,
      });
      ctx.toast('Saved');
      root.querySelector('#mm-key').value = '';
      root.querySelector('#mm-val').value = '';
    } catch (err) { ctx.toast('Error: ' + err.message); }
  };
  try {
    render(await api.rpc('memory.search', { query: '' }));
  } catch (e) { /* ignore */ }
};

/* ---------------------------------------------------------------- events --- */
Views.events = async function (root, ctx) {
  const { state } = ctx;
  root.innerHTML = '<h2>Events</h2><div class="toolbar"><input class="input" id="ev-filter" placeholder="filter type… (e.g. agent., tool.failed)" style="width:320px"></div><div id="ev-list" class="mono"></div>';
  const input = root.querySelector('#ev-filter');

  function render() {
    const f = input.value.trim();
    const list = root.querySelector('#ev-list');
    const evs = (state.events || []).filter((e) => !f || e.type.includes(f)).slice(-300).reverse();
    list.innerHTML = evs.map((e) =>
      '<div class="ev-row"><span class="ts">' + fmtTime(e.ts) + ' #' + e.seq + '</span> ' + (e.simulated ? '[sim] ' : '') + '<b>' + esc(e.type) + '</b> '
      + esc(JSON.stringify(e.data).slice(0, 220)) + '</div>').join('') || '<div class="empty">No events.</div>';
  }
  ctx.onEvents = render;
  input.oninput = render;
  render();
};

/* -------------------------------------------------------------- settings --- */
Views.settings = async function (root, ctx) {
  const { api, state } = ctx;
  root.innerHTML = '<h2>Settings</h2><div class="card"><h3>Connection</h3>'
    + '<div class="kv"><span class="k">server</span><span class="mono">' + esc(api.base) + '</span>'
    + '<span class="k">protocol</span><span class="mono">forge/1</span></div>'
    + '<label class="lbl">Auth token (stored in this browser only)</label>'
    + '<div class="toolbar"><input class="input" id="st-token" type="password" placeholder="Bearer token" style="flex:1" value="' + esc(api.token || '') + '">'
    + '<button class="btn small" id="st-save">Save</button></div>'
    + '<div style="font-size:11.5px;color:var(--faint)">Loopback access works without a token. Remote access requires the token from the server\'s token file.</div></div>'
    + '<div class="card"><h3>Session</h3><div class="kv"><span class="k">id</span><span class="mono">' + esc(state.sessionId || '-') + '</span>'
    + '<span class="k">project</span><span class="mono">' + esc(state.projectDir || '-') + '</span></div>'
    + '<div class="toolbar" style="margin-top:8px"><button class="btn small" id="st-ckpt">Create checkpoint…</button></div></div>'
    + '<div class="card"><h3>Configuration (secrets redacted)</h3><pre class="code" id="st-config">Loading…</pre></div>';

  root.querySelector('#st-save').onclick = () => {
    const tok = root.querySelector('#st-token').value.trim();
    api.setToken(tok || null);
    localStorage.setItem('forge.token', tok);
    ctx.toast('Token saved — reconnecting…');
    ctx.reconnect();
  };
  root.querySelector('#st-ckpt').onclick = async () => {
    const label = prompt('Checkpoint label:');
    if (!label) return;
    try {
      const c = await api.checkpointCreate(state.sessionId, label);
      ctx.toast('Checkpoint created: ' + c.id);
    } catch (err) { ctx.toast('Error: ' + err.message); }
  };
  try {
    root.querySelector('#st-config').textContent = JSON.stringify(await api.configGet(), null, 2);
  } catch (err) { root.querySelector('#st-config').textContent = 'Error: ' + err.message; }
};

window.ForgeViews = Views;
window.forgeEsc = esc;
window.forgeShortId = shortId;
window.forgeFmtTime = fmtTime;
