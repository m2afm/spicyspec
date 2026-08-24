/**
 * The agent tree, reconstructed from a worker's event stream.
 *
 * A tick is not one agent doing one thing. On tick 34 the worker dispatched 7 top-level
 * subagents, which dispatched their own, for 41 agent lifetimes and 243 progress events in
 * a single tick. None of that was visible anywhere: the dashboard showed a flat tool feed
 * and a count, so "4 subagents" was the entire story of an hour of fan-out.
 *
 * All of it is recoverable, because Claude Code's stream carries the full lifecycle:
 *
 *   task_started       task_id, tool_use_id, subagent_type, description, prompt
 *   task_progress      description, last_tool_name, usage{total_tokens, tool_uses, duration_ms}
 *   task_updated       patch{status, end_time}
 *   task_notification  status, summary, output_file, final usage
 *
 * and every event a subagent generates carries `parent_tool_use_id`, so its work is
 * attributable rather than merged into the parent's.
 *
 * This module is incremental on purpose: `ingest` takes one event and returns what changed,
 * so the server can tail the file and push deltas instead of re-parsing 2,000 events per
 * second per connected browser.
 */

/** How many progress lines to keep per agent. Enough to watch, bounded so memory is flat. */
const ACTIVITY_CAP = 60;

/** The root is the worker session itself — the one agent nobody dispatched. */
export const ROOT_ID = 'root';

export function createRegistry(meta = {}) {
  const root = {
    id: ROOT_ID,
    toolUseId: null,
    parentId: null,
    depth: 0,
    name: meta.name ?? 'worker',
    kind: 'session',
    description: meta.description ?? 'the tick worker',
    prompt: null,
    status: 'running',
    startedAt: meta.startedAt ?? null,
    endedAt: null,
    tokens: 0,
    toolUses: 0,
    durationMs: null,
    lastTool: null,
    lastActivity: null,
    lastActivityAt: null,
    summary: null,
    outputFile: null,
    contextTokens: 0,
    outputTokens: 0,
    activity: [],
    activityCount: 0,
    children: [],
  };
  return {
    agents: new Map([[ROOT_ID, root]]),
    /** tool_use_id -> agent id, so a child can find who dispatched it */
    byToolUse: new Map(),
    /** tool_use_id of an Agent/Task call -> the agent id that MADE the call */
    dispatcherOfToolUse: new Map(),
    order: [ROOT_ID],
    narration: [],
    counts: { spawned: 0, completed: 0, failed: 0, running: 1 },
  };
}

/** Which agent does this event belong to? Absent parent_tool_use_id means the root worker. */
function ownerOf(reg, event) {
  const p = event.parent_tool_use_id;
  if (!p) return ROOT_ID;
  return reg.byToolUse.get(p) ?? ROOT_ID;
}

function touch(agent, at) {
  if (at) agent.lastActivityAt = at;
}

/**
 * Append one activity line, keeping the retained window bounded.
 *
 * `activityCount` is the total ever produced and never decreases. The retained array does
 * shrink, because it shifts at the cap — so anything computing "what is new since I last
 * looked" from `activity.length` gets the wrong answer the moment an agent passes the cap,
 * and gets it silently: the arithmetic yields an empty slice, so a busy agent looks idle.
 * That is exactly what happened to the first version of the live feed.
 */
function pushActivity(agent, entry) {
  agent.activity.push(entry);
  agent.activityCount += 1;
  if (agent.activity.length > ACTIVITY_CAP) agent.activity.shift();
}

/**
 * Feed one stream event. Returns the ids whose state changed, so a caller can send just
 * those. An empty array means the event carried nothing a viewer would see.
 */
export function ingest(reg, event) {
  if (!event || typeof event !== 'object') return [];
  const at = event.timestamp ?? null;

  if (event.type === 'system') {
    switch (event.subtype) {
      case 'task_started':
        return startAgent(reg, event, at);
      case 'task_progress':
        return progressAgent(reg, event, at);
      case 'task_updated':
        return patchAgent(reg, event, at);
      case 'task_notification':
        return finishAgent(reg, event, at);
      default:
        return [];
    }
  }

  if (event.type === 'assistant') {
    const owner = reg.agents.get(ownerOf(reg, event));
    if (!owner) return [];
    let changed = false;

    // Context size, not consumption — and the distinction matters enough to be worth the
    // comment. Each turn's usage re-reports the whole prompt (cache reads included), so
    // SUMMING across turns would claim millions of tokens for a worker that has generated a
    // few thousand. The latest turn's prompt size is a real quantity, and it is the one that
    // governs the loop: a worker stops and writes its baton when its window runs low, so
    // watching this number is watching the tick approach its own end.
    const u = event.message?.usage;
    if (u) {
      const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (prompt > 0) owner.contextTokens = prompt;
      owner.outputTokens += u.output_tokens ?? 0;
    }
    for (const block of event.message?.content ?? []) {
      if (block.type === 'tool_use') {
        // Remember who made this call. When a task_started arrives quoting the tool_use_id,
        // this is the only way to know which agent is its PARENT — the task event itself
        // says what was dispatched, never by whom.
        reg.dispatcherOfToolUse.set(block.id, owner.id);
        owner.toolUses += 1;
        owner.lastTool = block.name;
        pushActivity(owner, { at, kind: 'tool', tool: block.name, detail: describeTool(block) });
        changed = true;
      } else if (block.type === 'text' && block.text?.trim()) {
        const text = block.text.trim();
        pushActivity(owner, { at, kind: 'say', detail: text.slice(0, 400) });
        // Only the root's narration is the tick's story; a subagent's prose is its own.
        if (owner.id === ROOT_ID) {
          reg.narration.push({ at, text });
          if (reg.narration.length > 40) reg.narration.shift();
        }
        changed = true;
      }
    }
    if (changed) touch(owner, at);
    return changed ? [owner.id] : [];
  }

  if (event.type === 'result') {
    const root = reg.agents.get(ROOT_ID);
    root.status = event.is_error ? 'failed' : 'completed';
    root.endedAt = at;
    root.durationMs = event.duration_ms ?? root.durationMs;
    root.summary = typeof event.result === 'string' ? event.result.slice(0, 2000) : root.summary;
    recount(reg);
    return [ROOT_ID];
  }

  return [];
}

function startAgent(reg, event, at) {
  const id = event.task_id;
  if (!id || reg.agents.has(id)) return [];
  const parentId = reg.dispatcherOfToolUse.get(event.tool_use_id) ?? ROOT_ID;
  const parent = reg.agents.get(parentId) ?? reg.agents.get(ROOT_ID);
  const agent = {
    id,
    toolUseId: event.tool_use_id ?? null,
    parentId: parent.id,
    depth: parent.depth + 1,
    name: event.subagent_type ?? event.task_type ?? 'agent',
    kind: event.task_type ?? 'local_agent',
    description: event.description ?? '(no description)',
    prompt: typeof event.prompt === 'string' ? event.prompt : null,
    status: 'running',
    startedAt: at,
    endedAt: null,
    tokens: 0,
    toolUses: 0,
    durationMs: null,
    lastTool: null,
    lastActivity: null,
    lastActivityAt: at,
    summary: null,
    outputFile: null,
    contextTokens: 0,
    outputTokens: 0,
    activity: [],
    activityCount: 0,
    children: [],
  };
  reg.agents.set(id, agent);
  reg.order.push(id);
  parent.children.push(id);
  if (agent.toolUseId) reg.byToolUse.set(agent.toolUseId, id);
  reg.counts.spawned += 1;
  recount(reg);
  return [id, parent.id];
}

function progressAgent(reg, event, at) {
  const agent = reg.agents.get(event.task_id);
  if (!agent) return [];
  if (event.description) {
    agent.lastActivity = event.description;
    pushActivity(agent, { at, kind: 'progress', tool: event.last_tool_name ?? null, detail: event.description });
  }
  if (event.last_tool_name) agent.lastTool = event.last_tool_name;
  if (event.usage) {
    // These are authoritative totals from the runtime, not our own tally — take them.
    if (typeof event.usage.total_tokens === 'number') agent.tokens = event.usage.total_tokens;
    if (typeof event.usage.tool_uses === 'number') agent.toolUses = event.usage.tool_uses;
    if (typeof event.usage.duration_ms === 'number') agent.durationMs = event.usage.duration_ms;
  }
  touch(agent, at);
  return [agent.id];
}

function patchAgent(reg, event, at) {
  const agent = reg.agents.get(event.task_id);
  if (!agent || !event.patch) return [];
  if (event.patch.status) agent.status = normaliseStatus(event.patch.status);
  if (event.patch.end_time) agent.endedAt = new Date(event.patch.end_time).toISOString();
  touch(agent, at);
  recount(reg);
  return [agent.id];
}

function finishAgent(reg, event, at) {
  const agent = reg.agents.get(event.task_id);
  if (!agent) return [];
  if (event.status) agent.status = normaliseStatus(event.status);
  if (event.summary) agent.summary = String(event.summary);
  if (event.output_file) agent.outputFile = event.output_file;
  if (event.usage) {
    if (typeof event.usage.total_tokens === 'number') agent.tokens = event.usage.total_tokens;
    if (typeof event.usage.tool_uses === 'number') agent.toolUses = event.usage.tool_uses;
    if (typeof event.usage.duration_ms === 'number') agent.durationMs = event.usage.duration_ms;
  }
  if (!agent.endedAt) agent.endedAt = at;
  touch(agent, at);
  recount(reg);
  return [agent.id];
}

/**
 * Four outcomes, because three of them get confused with each other.
 *
 * `completed` is what the runtime says for anything that ran to the end, regardless of what
 * it concluded — so it means "returned", not "was right".
 *
 * `stopped` is the one worth separating out. A background command the worker deliberately
 * gave up waiting on reports `killed` or `stopped`, and calling that a failure paints a red
 * card on a normal, intentional act. On tick 35 that was a "wait for explore agent" shell
 * the worker cancelled once the agent it was waiting for had already returned. A dashboard
 * that flags that as broken is a dashboard whose warnings you learn to ignore.
 *
 * Anything genuinely unrecognised falls through to `failed`, so a new outcome word shows up
 * as a problem to look at rather than being silently counted as a success.
 */
function normaliseStatus(raw) {
  const s = String(raw).toLowerCase();
  if (s === 'completed' || s === 'success' || s === 'succeeded') return 'completed';
  if (s === 'running' || s === 'in_progress' || s === 'pending' || s === 'started') return 'running';
  if (s === 'killed' || s === 'stopped' || s === 'cancelled' || s === 'canceled' || s === 'aborted') return 'stopped';
  return 'failed';
}

function recount(reg) {
  let running = 0, completed = 0, failed = 0, stopped = 0;
  for (const a of reg.agents.values()) {
    if (a.status === 'running') running += 1;
    else if (a.status === 'completed') completed += 1;
    else if (a.status === 'stopped') stopped += 1;
    else failed += 1;
  }
  reg.counts.running = running;
  reg.counts.completed = completed;
  reg.counts.failed = failed;
  reg.counts.stopped = stopped;
}

/** A short human label for a tool call, so the feed reads as work rather than as JSON. */
export function describeTool(block) {
  const i = block.input ?? {};
  const trim = (s, n = 120) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) + '…' : s) : '');
  switch (block.name) {
    case 'Bash': return trim(i.command);
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return trim(i.file_path);
    case 'Grep': return trim(i.pattern) + (i.path ? '  in ' + trim(i.path, 60) : '');
    case 'Glob': return trim(i.pattern);
    case 'Agent': case 'Task': return (i.subagent_type ? i.subagent_type + ' — ' : '') + trim(i.description);
    case 'Skill': return trim(i.skill);
    case 'TodoWrite': return (i.todos?.length ?? 0) + ' items';
    default: return trim(i.description || i.pattern || i.command || i.file_path || '');
  }
}

/** Serialisable view. `detail` false omits prompts and activity, which dominate the size. */
export function snapshot(reg, { detail = false } = {}) {
  const agents = reg.order.map((id) => {
    const a = reg.agents.get(id);
    const base = {
      id: a.id, parentId: a.parentId, depth: a.depth, name: a.name, kind: a.kind,
      description: a.description, status: a.status, startedAt: a.startedAt, endedAt: a.endedAt,
      tokens: a.tokens, toolUses: a.toolUses, durationMs: a.durationMs,
      lastTool: a.lastTool, lastActivity: a.lastActivity, lastActivityAt: a.lastActivityAt,
      children: a.children.slice(), hasPrompt: Boolean(a.prompt),
      contextTokens: a.contextTokens, outputTokens: a.outputTokens,
      summaryLine: a.summary ? String(a.summary).slice(0, 220) : null,
    };
    if (!detail) return base;
    return { ...base, prompt: a.prompt, summary: a.summary, outputFile: a.outputFile,
      activity: a.activity.slice(), activityCount: a.activityCount };
  });
  return { agents, counts: { ...reg.counts } };
}

export function agentDetail(reg, id) {
  const a = reg.agents.get(id);
  if (!a) return null;
  return {
    id: a.id, parentId: a.parentId, depth: a.depth, name: a.name, kind: a.kind,
    description: a.description, status: a.status, startedAt: a.startedAt, endedAt: a.endedAt,
    tokens: a.tokens, toolUses: a.toolUses, durationMs: a.durationMs, lastTool: a.lastTool,
    lastActivity: a.lastActivity, prompt: a.prompt, summary: a.summary,
    contextTokens: a.contextTokens, outputTokens: a.outputTokens,
    outputFile: a.outputFile, activity: a.activity.slice(), activityCount: a.activityCount,
    children: a.children.slice(),
  };
}
