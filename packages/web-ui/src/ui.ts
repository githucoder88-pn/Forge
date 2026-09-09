import { ForgeClient } from "@forge/client";
import type {
  Agent,
  AgentId,
  EventEnvelope,
  Message,
  Session,
  SessionId,
  SessionSnapshot,
} from "@forge/protocol";

export interface ForgeUIOpts {
  defaultCoreUrl?: string;
  storagePrefix?: string;
}

interface ChangedFile {
  path: string;
  kind: "created" | "modified" | "deleted";
  diffPreview?: string;
  ts: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Mount the Forge Phase-1 client UI. State = snapshot + event stream
 * (no polling refresh loops). All values come from Core.
 */
export function mountForgeUI(root: HTMLElement, opts: ForgeUIOpts = {}): { dispose: () => void } {
  const store = (k: string): string | null => {
    try {
      return localStorage.getItem(`${opts.storagePrefix ?? "forge"}.${k}`);
    } catch {
      return null;
    }
  };
  const save = (k: string, v: string): void => {
    try {
      localStorage.setItem(`${opts.storagePrefix ?? "forge"}.${k}`, v);
    } catch {
      /* private mode */
    }
  };

  let client: ForgeClient | null = null;
  let sessionId: SessionId | null = null;
  let snapshot: SessionSnapshot | null = null;
  let sub: { close: () => void } | null = null;
  let runningAgent: AgentId | null = null;
  let streamBubble: HTMLElement | null = null;
  let disposed = false;
  const changedFiles = new Map<string, ChangedFile>();
  let healthTimer: ReturnType<typeof setInterval> | null = null;

  // ---------- layout ----------
  root.innerHTML = "";
  const app = el("div", "forge");
  const topbar = el("div", "forge-topbar");
  topbar.append(el("span", "forge-brand", "Forge"));
  const dot = el("span", "forge-dot");
  topbar.append(dot);
  const coreInput = el("input") as HTMLInputElement;
  coreInput.type = "text";
  coreInput.value = store("coreUrl") ?? opts.defaultCoreUrl ?? "http://127.0.0.1:8710";
  coreInput.style.width = "210px";
  coreInput.title = "Core URL";
  const connectBtn = el("button", "", "Connect");
  const sessionSel = el("select") as HTMLSelectElement;
  const newBtn = el("button", "", "New session");
  const wsLabel = el("span", "forge-ws", "not connected");
  wsLabel.style.flex = "1";
  topbar.append(coreInput, connectBtn, sessionSel, newBtn, wsLabel);
  app.append(topbar);

  const main = el("div", "forge-main");
  const conv = el("div", "forge-conv");
  const msgs = el("div", "forge-msgs");
  const inputbar = el("div", "forge-inputbar");
  const taskInput = el("textarea") as HTMLTextAreaElement;
  taskInput.placeholder = "Describe a coding task — e.g. Fix the failing test in this repository. (Ctrl+Enter to run)";
  const btnCol = el("div", "col");
  const runBtn = el("button", "primary", "Run");
  const cancelBtn = el("button", "danger", "Cancel");
  cancelBtn.disabled = true;
  btnCol.append(runBtn, cancelBtn);
  inputbar.append(taskInput, btnCol);
  conv.append(msgs, inputbar);

  const side = el("div", "forge-side");
  const tabs = el("div", "forge-tabs");
  const panes: Record<string, HTMLElement> = {};
  for (const name of ["Agent", "Activity", "Files", "Terminal"]) {
    const b = el("button", name === "Agent" ? "active" : "", name);
    b.onclick = () => {
      for (const t of tabs.children) t.classList.remove("active");
      b.classList.add("active");
      for (const [k, p] of Object.entries(panes)) p.classList.toggle("active", k === name);
    };
    tabs.append(b);
    const pane = el("div", name === "Agent" ? "forge-pane active" : "forge-pane");
    panes[name] = pane;
  }
  side.append(tabs, panes.Agent!, panes.Activity!, panes.Files!, panes.Terminal!);
  main.append(conv, side);
  app.append(main);
  root.append(app);

  const agentPane = panes.Agent!;
  const activityPane = panes.Activity!;
  const filesPane = panes.Files!;
  const termPane = panes.Terminal!;
  const activityLog = el("div", "forge-log");
  activityPane.append(activityLog);
  const termPre = el("div", "forge-term");
  termPane.append(termPre);
  const approvalsBox = el("div");
  agentPane.append(approvalsBox);

  // ---------- render helpers ----------
  function scrollDown(c: HTMLElement): void {
    c.scrollTop = c.scrollHeight;
  }

  function addMessage(m: { role: string; content: string; agentId?: string | null }): void {
    if (m.role === "tool") return; // tool traffic lives in Activity/Terminal
    if (m.role === "agent") clearStreamBubble();
    const box = el("div", `forge-msg ${m.role === "user" ? "user" : "agent"}`);
    box.append(el("div", "who", m.role === "user" ? "You" : `Agent${m.agentId ? ` · ${m.agentId.slice(0, 14)}…` : ""}`));
    const body = el("div", "body", m.content);
    box.append(body);
    msgs.append(box);
    scrollDown(msgs);
  }

  function clearStreamBubble(): void {
    streamBubble?.remove();
    streamBubble = null;
  }

  function updateStreamBubble(text: string): void {
    if (!streamBubble) {
      streamBubble = el("div", "forge-msg agent streaming");
      streamBubble.append(el("div", "who", "Agent · streaming"));
      streamBubble.append(el("div", "body", ""));
      msgs.append(streamBubble);
    }
    const body = streamBubble.querySelector(".body");
    if (body) body.textContent = text; // rolling window: replace, don't append
    scrollDown(msgs);
  }

  function activity(e: EventEnvelope, detail?: string): void {
    const row = el("div", "row");
    const seq = el("span", "seq", `#${e.seq}`);
    const cls = e.type.startsWith("agent.") ? "t-agent" : e.type.startsWith("model.") ? "t-model" : e.type.startsWith("tool.") ? "t-tool" : e.type.startsWith("file.") ? "t-file" : e.type.startsWith("test.") ? "t-test" : e.type.startsWith("command.") ? "t-cmd" : "";
    const type = el("span", cls, e.type);
    row.append(seq, type);
    if (detail) row.append(el("span", e.type.endsWith("failed") ? "fail" : "", ` — ${detail}`));
    activityLog.append(row);
    while (activityLog.children.length > 500) activityLog.firstChild?.remove();
    scrollDown(activityPane);
  }

  function term(line: string): void {
    termPre.textContent += (termPre.textContent ? "\n" : "") + line.slice(0, 4000);
    if (termPre.textContent.length > 100_000) termPre.textContent = termPre.textContent.slice(-100_000);
    scrollDown(termPane);
  }

  function activeAgent(): Agent | null {
    if (!snapshot) return null;
    if (runningAgent) return snapshot.agents.find((a) => a.id === runningAgent) ?? null;
    if (snapshot.session.activeAgentId) return snapshot.agents.find((a) => a.id === snapshot!.session.activeAgentId) ?? null;
    return snapshot.agents[snapshot.agents.length - 1] ?? null;
  }

  function renderAgent(): void {
    // Preserve approvals box; rebuild the rest.
    for (const child of [...agentPane.children]) {
      if (child !== approvalsBox) child.remove();
    }
    const a = activeAgent();
    if (!a) {
      agentPane.prepend(el("div", "forge-empty", "No agent yet. Describe a task and press Run."));
      return;
    }
    const pill = el("span", `forge-state ${a.state}`, a.state);
    const head = el("div");
    head.append(el("strong", "", `${a.name} `), pill);
    agentPane.prepend(head);
    const bar = el("div", "forge-bar");
    const fill = el("div") as HTMLDivElement;
    fill.style.width = `${Math.round(a.progress * 100)}%`;
    bar.append(fill);
    agentPane.append(bar);
    const kv = el("dl", "forge-kv");
    const rows: [string, string][] = [
      ["id", a.id],
      ["model", `${a.provider}/${a.model}`],
      ["task", a.currentTask ?? "—"],
      ["progress", a.progress.toFixed(2)],
      ["model calls", String(a.metrics.modelCalls)],
      ["tool calls", String(a.metrics.toolCalls)],
      ["tokens in/out", `${a.metrics.inputTokens}/${a.metrics.outputTokens}`],
      ["files r/w", `${a.metrics.filesRead}/${a.metrics.filesWritten}`],
      ["commands", String(a.metrics.commandsRun)],
      ["tests", String(a.metrics.testsRun)],
      ["updated", a.updatedAt],
    ];
    if (a.lastError) rows.push(["last error", a.lastError]);
    for (const [k, v] of rows) {
      kv.append(el("dt", "", k), el("dd", "", v));
    }
    agentPane.append(kv);
    agentPane.append(approvalsBox);
  }

  function renderFiles(): void {
    filesPane.innerHTML = "";
    if (changedFiles.size === 0) {
      filesPane.append(el("div", "forge-empty", "No file changes in this session yet."));
      return;
    }
    for (const f of [...changedFiles.values()].reverse()) {
      const box = el("div", "forge-file");
      const head = el("div", "head");
      head.append(el("span", "", `${f.kind === "deleted" ? "−" : f.kind === "created" ? "+" : "~"} ${f.path}`));
      head.append(el("span", "", f.ts.slice(11, 19)));
      const pre = el("pre");
      pre.style.display = "none";
      if (f.diffPreview) {
        for (const line of f.diffPreview.split("\n").slice(0, 120)) {
          const span = el("span", line.startsWith("+") ? "forge-diff-add" : line.startsWith("-") ? "forge-diff-del" : "", line + "\n");
          pre.append(span);
        }
      } else {
        pre.textContent = "(no diff preview)";
      }
      head.onclick = () => {
        pre.style.display = pre.style.display === "none" ? "block" : "none";
      };
      box.append(head, pre);
      filesPane.append(box);
    }
  }

  function setConnected(on: boolean): void {
    dot.className = `forge-dot ${on ? "on" : "off"}`;
  }

  // ---------- event application ----------
  function applyEvent(e: EventEnvelope): void {
    const p = e.payload as Record<string, unknown>;
    switch (e.type) {
      case "message.user":
        addMessage({ role: "user", content: String(p.content ?? "") });
        activity(e, String(p.content ?? "").slice(0, 120));
        break;
      case "message.agent":
        addMessage({ role: "agent", content: String(p.content ?? ""), agentId: p.agentId as string | undefined });
        activity(e);
        break;
      case "model.stream":
        updateStreamBubble(String((p as { chunk?: string }).chunk ?? ""));
        break;
      case "model.requested":
      case "model.started":
        activity(e, `${p.provider}/${p.model}`);
        break;
      case "model.completed": {
        clearStreamBubble();
        const tools = ((p.toolCalls as { tool: string }[] | undefined) ?? []).map((t) => t.tool).join(", ");
        activity(e, tools ? `tools: ${tools}` : "answered");
        break;
      }
      case "model.failed":
        clearStreamBubble();
        activity(e, String(p.error ?? ""));
        break;
      case "tool.started":
        activity(e, String(p.tool ?? ""));
        term(`$ ${String(p.tool ?? "")} …`);
        break;
      case "tool.output": {
        const chunk = String((p as { chunk?: string }).chunk ?? "");
        if (chunk) term(chunk.replace(/\n$/, ""));
        break;
      }
      case "tool.completed":
        activity(e, `${String(p.tool ?? "")} ✓ ${String(p.durationMs ?? "?")}ms`);
        break;
      case "tool.failed":
        activity(e, `${String(p.tool ?? "")} ✗ ${String(p.error ?? "").slice(0, 160)}`);
        break;
      case "file.created":
      case "file.modified":
      case "file.deleted": {
        const path = String(p.path ?? "?");
        changedFiles.set(path, { path, kind: e.type.slice(5) as ChangedFile["kind"], diffPreview: p.diffPreview as string | undefined, ts: e.ts });
        renderFiles();
        activity(e, path);
        break;
      }
      case "command.started":
        activity(e, String(p.command ?? "").slice(0, 120));
        term(`$ ${String(p.command ?? "")}`);
        break;
      case "command.output": {
        const chunk = String((p as { chunk?: string }).chunk ?? "");
        if (chunk) term(chunk.replace(/\n$/, ""));
        break;
      }
      case "command.completed":
      case "command.failed":
        activity(e, `exit ${String(p.exitCode ?? "?")} — ${String(p.command ?? "").slice(0, 100)}`);
        break;
      case "test.started":
        activity(e, String(p.command ?? ""));
        term(`▶ tests: ${String(p.command ?? "")}`);
        break;
      case "test.passed":
        activity(e, `PASSED ${String(p.durationMs ?? "?")}ms`);
        term(`✔ tests passed`);
        break;
      case "test.failed":
        activity(e, `FAILED — ${String(p.summary ?? "").slice(0, 160)}`);
        term(`✘ tests failed: ${String(p.summary ?? "").slice(0, 300)}`);
        break;
      case "agent.created":
        activity(e, String((p.agentId as string ?? "").slice(0, 18)));
        break;
      case "agent.started":
        runningAgent = p.agentId as AgentId;
        runBtn.disabled = true;
        cancelBtn.disabled = false;
        activity(e, `task: ${String(p.task ?? "").slice(0, 120)}`);
        void refreshAgents();
        break;
      case "agent.state_changed":
        activity(e, `${String(p.from)} → ${String(p.to)}`);
        void refreshAgents();
        break;
      case "agent.progress":
        void refreshAgents();
        break;
      case "agent.completed":
      case "agent.failed":
      case "agent.cancelled":
        clearStreamBubble();
        activity(e, e.type === "agent.completed" ? `${String(p.iterations ?? "?")} iterations` : String((p as { error?: string; reason?: string }).error ?? (p as { reason?: string }).reason ?? ""));
        runningAgent = null;
        runBtn.disabled = false;
        cancelBtn.disabled = true;
        void refreshAgents();
        break;
      case "approval.requested":
        showApproval(p.approvalId as string, String(p.tool ?? ""), String(p.reason ?? ""), p.input);
        activity(e, `${String(p.tool)} — ${String(p.reason)}`);
        break;
      case "approval.resolved":
        resolveApprovalCard(String(p.approvalId ?? ""), Boolean(p.approved));
        activity(e, String(p.approvalId ?? ""));
        break;
      case "session.created":
      case "session.resumed":
        activity(e);
        break;
      default:
        activity(e);
    }
  }

  async function refreshAgents(): Promise<void> {
    if (!client || !sessionId || disposed) return;
    try {
      const { snapshot: snap } = await client.getSessionState(sessionId, 0);
      // Keep local message list authoritative for scrollback; refresh agents only.
      if (snapshot) snapshot.agents = snap.agents;
      else snapshot = snap;
      renderAgent();
    } catch {
      /* transient */
    }
  }

  function showApproval(id: string, tool: string, reason: string, input: unknown): void {
    const card = el("div", "forge-approval");
    card.dataset.approval = id;
    card.append(el("div", "", `Approval required: ${tool}`));
    card.append(el("div", "", reason));
    const pre = el("div", "forge-ws", JSON.stringify(input)?.slice(0, 300) ?? "");
    const btns = el("div", "btns");
    const ok = el("button", "primary", "Approve");
    const no = el("button", "danger", "Deny");
    ok.onclick = () => void client?.resolveApproval(id, true).then(() => resolveApprovalCard(id, true));
    no.onclick = () => void client?.resolveApproval(id, false).then(() => resolveApprovalCard(id, false));
    btns.append(ok, no);
    card.append(pre, btns);
    approvalsBox.append(card);
  }

  function resolveApprovalCard(id: string, approved: boolean): void {
    const card = approvalsBox.querySelector(`[data-approval="${CSS.escape(id)}"]`);
    if (card) {
      card.textContent = `Approval ${id.slice(0, 16)}… ${approved ? "approved" : "denied"}`;
      setTimeout(() => card.remove(), 4000);
    }
  }

  // ---------- session lifecycle ----------
  async function selectSession(id: SessionId): Promise<void> {
    if (!client) return;
    sub?.close();
    sub = null;
    sessionId = id;
    save("sessionId", id);
    msgs.innerHTML = "";
    activityLog.innerHTML = "";
    termPre.textContent = "";
    changedFiles.clear();
    renderFiles();
    clearStreamBubble();
    try {
      const { snapshot: snap, events } = await client.getSessionState(id, 0);
      snapshot = snap;
      wsLabel.textContent = snap.session.workspaceRoot;
      for (const m of snap.messages as Message[]) {
        if (m.role === "user" || m.role === "agent") addMessage({ role: m.role, content: m.content, agentId: m.agentId });
      }
      // Rebuild changed files + activity from persisted events (deterministic).
      for (const e of events) {
        if (e.type === "file.created" || e.type === "file.modified" || e.type === "file.deleted") {
          const fp = e.payload as { path: string; diffPreview?: string };
          changedFiles.set(fp.path, { path: fp.path, kind: e.type.slice(5) as ChangedFile["kind"], diffPreview: fp.diffPreview, ts: e.ts });
        }
      }
      renderFiles();
      for (const e of events.slice(-200)) {
        if (e.type !== "message.user" && e.type !== "message.agent" && e.type !== "model.stream") activity(e);
      }
      renderAgent();
      const live = snap.agents.find((a) => ["executing", "planning", "waiting_for_tool", "reviewing"].includes(a.state));
      runningAgent = live ? live.id : null;
      runBtn.disabled = runningAgent !== null;
      cancelBtn.disabled = runningAgent === null;
      sub = client.subscribe(id, (e) => applyEvent(e), { afterSeq: snap.lastSeq });
    } catch (err) {
      wsLabel.textContent = `failed to load session: ${(err as Error).message}`;
    }
  }

  async function refreshSessions(preselect?: string): Promise<void> {
    if (!client) return;
    sessionSel.innerHTML = "";
    try {
      const { sessions } = await client.listSessions();
      for (const s of sessions as Session[]) {
        const opt = document.createElement("option");
        opt.value = s.id;
        opt.textContent = `${s.title} — ${s.workspaceRoot}`;
        sessionSel.append(opt);
      }
      const pick = preselect ?? store("sessionId");
      if (pick && [...sessionSel.options].some((o) => o.value === pick)) {
        sessionSel.value = pick;
        await selectSession(pick as SessionId);
      } else if (sessionSel.options.length > 0) {
        sessionSel.selectedIndex = 0;
        await selectSession(sessionSel.value as SessionId);
      }
    } catch {
      /* not connected */
    }
  }

  async function connect(): Promise<void> {
    const url = coreInput.value.trim();
    save("coreUrl", url);
    client = new ForgeClient(url);
    try {
      await client.health();
      setConnected(true);
      wsLabel.textContent = "connected";
      await refreshSessions();
    } catch (err) {
      setConnected(false);
      wsLabel.textContent = `unreachable: ${(err as Error).message}`;
    }
  }

  // ---------- wiring ----------
  connectBtn.onclick = () => void connect();
  sessionSel.onchange = () => void selectSession(sessionSel.value as SessionId);
  newBtn.onclick = () => {
    if (!client) return;
    const lastWs = store("workspace") ?? "";
    const wsRoot = window.prompt("Workspace root (absolute path):", lastWs);
    if (!wsRoot) return;
    save("workspace", wsRoot);
    void client
      .createSession({ workspaceRoot: wsRoot })
      .then(async (s) => {
        await refreshSessions(s.id);
      })
      .catch((err: Error) => {
        window.alert(`Failed to create session: ${err.message}`);
      });
  };
  runBtn.onclick = () => {
    if (!client || !sessionId) {
      window.alert("Connect to Core and select a session first.");
      return;
    }
    const task = taskInput.value.trim();
    if (!task) return;
    taskInput.value = "";
    runBtn.disabled = true;
    void client
      .sendMessage(sessionId, task)
      .then(({ agentId }) => {
        runningAgent = agentId;
        cancelBtn.disabled = false;
      })
      .catch((err: Error) => {
        window.alert(`Failed to start agent: ${err.message}`);
        runBtn.disabled = false;
      });
  };
  taskInput.addEventListener("keydown", (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === "Enter") runBtn.click();
  });
  cancelBtn.onclick = () => {
    if (!client || !runningAgent) return;
    cancelBtn.disabled = true;
    void client.cancelAgent(runningAgent, "cancelled from UI").catch(() => {
      cancelBtn.disabled = false;
    });
  };

  healthTimer = setInterval(() => {
    if (!client || disposed) return;
    void client.health().then(
      () => setConnected(true),
      () => setConnected(false),
    );
  }, 10_000);

  void connect();

  return {
    dispose: () => {
      disposed = true;
      sub?.close();
      if (healthTimer) clearInterval(healthTimer);
    },
  };
}
