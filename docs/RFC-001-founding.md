# RFC-001 — Spicyspec: founding architecture

Status: **ratified** (founder, 2026-08-24) · Author: bootstrap session · Supersedes: nothing — this is the first record.

---

## 1. What Spicyspec is

**An agentic delivery platform.** Input: an idea, a documentation set, or a competition brief.
Output: a **handoff package** — a working app in dev mode, plus the spec kit that produced it,
gate records, test evidence, and production-adjustment notes — ready for a production team to
adapt and launch.

One sentence: *GitHub Actions for building whole apps, with a spec-driven pipeline as the brain
and evidence-paired verification as the differentiator.*

Target users: solo founders → mid-size teams → enterprise. Same engine, pipeline depth scales.

### 1.1 Where it comes from

Spicyspec productizes a working prototype: the Airvia build loop
(`airvia/.specify/loop/`, ~7,600 LOC hand-rolled Node ESM), which ran unattended for 48+ hours,
39+ ticks, closed 191 tasks across 4 feature specs, and recorded **47 defects in its own
machinery** (`BUGS-ON-THE-GO.md`). Those 47 defects are the founding asset: each one is an
encoded lesson, and each becomes a regression test in this repo. The domain logic
(queue invariants, tick classification, attribution guard, gate records, account pooling)
is ported; the hand-rolled carriers (process supervision, flat-file state, stream parsing,
ad-hoc HTTP dashboard) are replaced with mature equivalents.

Defect-class → replacement mapping (measured, not guessed):

| Defect class (count) | Examples | Replaced by |
|---|---|---|
| Process supervision (8) | orphaned worker kept writing; double-writer on one tree; stale lock; watchdog killed healthy 12-min-silent test run; restart raced a halt | **Temporal** durable execution |
| Stream/CLI parsing (5) | `spawn kimi ENOENT`; no `error` listener; tool-count wrong; prose parsed as tasks; a subagent's text retired a spec | **@anthropic-ai/claude-agent-sdk** typed events |
| Flat-file state (5) | tracked-then-rewritten queue file; worker-writable "project finished" flag; git index shared between writers | **Postgres/SQLite** ACID via one repository interface |
| Hand-rolled dashboard (10+) | CSRF-open process-control API; 27 orphaned server processes; blank page that passed its tests | **Angular** control-plane UI + real framework middleware |
| Windows supervision (1) | `pm2 startup` → "Init system not found"; logon-script workaround | **WinSW** (Windows) / **systemd** (Linux) runner services |

## 2. Core mental model: control plane + runners

The binding constraint: **AI subscription auth is personal** (a Claude Code subscription lives
on a person's machine/account). So Spicyspec copies the proven shape — GitHub Actions
self-hosted runners:

- **Control plane** (one server, team-shared): projects, pipeline definitions, run queue, gate
  records, evidence store, approvals inbox, dashboards, notifications. Postgres + API + Angular UI.
- **Runners** (a daemon each team member installs): registers with the control plane, brings its
  own provider accounts (N Claude accounts, Kimi, GLM, …), polls for jobs, executes worker
  sessions locally, streams evidence back.

Runners **dial out** (poll). Nothing inbound reaches a laptop behind NAT. This is the decisive
reason for Temporal over HTTP-invoke engines (§4.2).

Solo mode = control plane and one runner on the same machine, SQLite instead of Postgres,
`temporal server start-dev` instead of a cluster. Same code paths.

## 3. The seven layers (each a plugin surface)

1. **Provider layer** — one adapter contract per AI vendor:
   `spawn(session) / stream(events) / interrupt() / cost()`. Packages:
   `provider-claude` (Agent SDK), `provider-kimi`, `provider-glm`, `provider-openai`, …
   **Adding a new AI = writing one adapter package.** First-class product feature.
2. **Account pool** — per provider, per runner: warm/cold state, limit-type awareness
   (five-hour vs weekly quotas held in reserve), refusal cooldown (`401/403` ≠ rate limit ≠
   worker failure). Ported from the Airvia pool — battle-tested logic.
3. **Agent registry** — agent types as declarative, versioned manifests (the `.claude/agents/*.md`
   pattern, generalized). Adding an agent type = dropping a manifest. Shareable across a team.
4. **Skill & gate packs** — installable packages with a manifest declaring *which pipeline stage
   they gate*: `skill-frontend-checklist` (exists in prototype form), `skill-backend-checklist`,
   `skill-security-check`, `skill-pentest`. The future marketplace surface.
5. **Pipeline engine** — the spec-kit stages generalized and declarative:
   `intake (idea/docs/brief) → specify → clarify → plan → tasks → execute (waves) → converge →
   gate-suite → handoff`. A simple app runs a short pipeline; an enterprise app runs the full
   pipeline plus compliance packs. Same engine, declared depth.
6. **State & evidence** — Postgres (team) / SQLite (solo) behind one repository interface, plus a
   per-run **append-only evidence log**: every quality claim paired with the executed command
   that proves it (the Airvia harvest/GATES.jsonl pattern, generalized). *A gate approval with no
   matching execution evidence is treated as fabricated.* This honesty layer is the moat.
7. **Manager UI** — projects board, live runs, gate timeline, approvals inbox (parked questions
   become answerable cards, replies flow back into the run), journey kiosk (the run preps seeded
   DB + dev server + deep link + checklist; the human clicks), cost/account telemetry, push
   notifications (a run waiting on a human must never be silent — the prototype measured 91% of
   all idle time coming from exactly that silence).

## 4. Stack decisions (ratified 2026-08-24)

| Decision | Choice | Status |
|---|---|---|
| Repo | **Standalone Nx monorepo** (`spicyspec`), Airvia becomes first consumer/dogfood tenant | ratified |
| Language | **TypeScript strict** everywhere | ratified |
| Worker layer | **@anthropic-ai/claude-agent-sdk** behind the provider contract | ratified |
| Durable execution | **Temporal** (dev: `temporal server start-dev` single binary, local, SQLite persistence; prod later: Docker compose on a VPS or Temporal Cloud) | ratified — local-first explicitly confirmed |
| DB | **Postgres + Prisma** (team) / **SQLite** (solo), one repository interface | ratified |
| Control-plane UI | **Angular** (team fluency; Airvia web is Angular 22) | ratified |
| Runner supervision | **WinSW** (Windows service) / systemd (Linux) — replaces pm2 | ratified |
| Tests | **vitest** (unit), Playwright (UI later) | ratified |
| Validation | **zod** at every boundary (config, gate records, provider events) | ratified |
| License / distribution | undecided — product may be commercial; do NOT add an OSS license silently | **open** |

### 4.1 Why Temporal (over Inngest / BullMQ / hand-rolled)

- Workers **poll** task queues (dial-out) — fits runners on personal machines behind NAT.
  Inngest's core model invokes your HTTP endpoint (its "connect" worker mode is its youngest part).
- Activities with **heartbeats** natively detect dead workers — the orphan/watchdog defect class
  (8 of 47) vanishes into the engine.
- Signals + durable timers: day-long human-approval waits cost nothing and survive restarts.
- Self-hostable (MIT server) — the first question enterprise buyers ask.
- Dev story on Windows: one binary, no Docker (`temporal server start-dev --db-filename …`).
- Cost of adoption: deterministic-workflow rules (no `Date.now()`/`Math.random()` inside
  workflow code — replay safety). Bounded learning curve, ~a week.
- **Migration path** (founder-confirmed sequencing): local dev server now → VPS/Cloud when the
  first external runner appears. Workflow code unchanged; workers repoint one connection
  address. In-flight runs do NOT migrate between servers — cut over between runs.
- Escape hatch: pipeline stages are pure functions in `packages/core`; Temporal only sequences
  them. If it ever proves wrong, the swap boundary is sequencing, not logic.

### 4.2 BullMQ / own-state-machine rejections

BullMQ: a queue, not durable execution — multi-step run state would be hand-rolled again, plus
a Redis dependency on Windows. Own state machine: re-implements heartbeats/timers/retries/replay,
the exact class that produced 12 of the prototype's 47 defects. Rejected at team scale.

## 5. The output contract: the handoff package

A run ends with a defined artifact, never "code somewhere":

- repo at a frozen SHA, app boots in dev mode
- the spec kit that produced it (spec, plan, tasks, clarifications, decision log)
- gate records (machine-readable, evidence-paired) + review prose
- test evidence: suites executed, coverage, red-first proofs
- security / pentest / checklist pack reports
- runbook + production-adjustment notes for the receiving team

This contract is what makes mid/enterprise buyers able to say yes — the output is auditable.

## 6. Roadmap

- **Phase 0 — extract** *(this repo, now)*: port the battle-tested pure domain modules from the
  Airvia loop into `packages/core` (TypeScript, vitest). The 47 recorded defects become named
  regression tests. The Airvia loop keeps running untouched.
- **Phase 1 — engine**: provider contract + `provider-claude` (Agent SDK) + Temporal workflows
  (run = workflow, tick = activity, approval = signal) + repository layer (SQLite first).
  Single-runner mode replaces the Airvia driver; Airvia dogfoods it.
- **Phase 2 — team**: control plane (API + Postgres) + runner daemon + registration/auth +
  service install (WinSW/systemd). Teammates connect. Temporal moves to VPS.
- **Phase 3 — product**: Angular manager UI top-tier pass, skill/gate packs formalized
  (frontend-checklist ported; backend-checklist, security-check, pentest authored), handoff
  package generator, push notifications, journey kiosk.
- **Phase 4 — market**: multi-tenant, RBAC/SSO, marketplace for packs/agents/providers,
  competition-brief intake mode.

Honest sizing: Phases 0–1 = weeks. Through Phase 3 = a quarter-scale product build.

## 7. Non-negotiable engineering rules (inherited from the prototype's scars)

1. **Evidence over narration.** A claim ("tests pass", "gate approved") is only real when paired
   with the executed command and its output in the evidence log. Absence = UNKNOWN, never PASS.
2. **Severity discipline for state repair**: `repair` only when the correct state is unambiguous
   from evidence; `halt` when the state cannot be reasoned about (never guess); `warn` otherwise.
   Nothing above `warn` may depend on parsing prose.
3. **An operator/infra event is never a worker failure.** Account refusal, rate limit, operator
   kill — none may count toward stall limits that park work.
4. **Only top-level agent turns speak for a worker.** Subagent output is data.
5. **Human sign-off is a recorded, walked journey** — the platform preps it, a human clicks it.
   The prototype's only detector that ever caught the unreachable-screen class.
6. **No silent guardrails.** A protection that is advertised but unenforced is a defect
   (prototype B25). Enforce via SDK permission hooks, verify via evidence.
7. **Append-only records** for gates/decisions; last line = current state; a re-review after
   fixes is a new record, never an edit.

## 8. Open questions (parked, not blocking)

- Final product name/branding (working name Spicyspec; user's phrasing suggests naming pass later).
- License & commercial model (see §4 — do not default to OSS).
- Tracker/second-vendor judge chain: which fallback order (Kimi → GLM → Gemini?) and schema.
  Prototype lesson (2026-08-23): the single-vendor tracker died to a quota mid-run; the chain
  is a requirement, not an option.
- Control-plane hosting default for Phase 2 (VPS vs Temporal Cloud + small API host).
- How much of the Airvia org-board/council model ships as the default review topology vs a pack.
