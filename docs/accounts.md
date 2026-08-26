# Adding accounts — the multi-account rotation setup

The runner rotates WITHIN a spec across every account you give it, so one person's rate limits stop
being the loop's ceiling. This page is the whole setup; nothing else is required.

## The two halves

Accounts are declared in `spicyspec.runner.json` (safe to commit) and credentialed in
`spicyspec.runner.secrets.json` **beside it** (never commit this file — add it to `.gitignore`).
The runner derives the secrets path from the config path (`main.ts`: `config.json` →
`config.secrets.json`) and merges the two at build time. Secrets are handed to the worker process's
environment and **never persisted in the store** (`wiring.ts:51`).

### 1 · Declare the account (committed)

```jsonc
// spicyspec.runner.json
"accounts": [
  { "id": "primary",   "label": "main account (ambient login)",  "env": {}, "configDir": null },
  { "id": "secondary", "label": "token in the secrets file",     "env": {}, "configDir": null },
  { "id": "tertiary",  "label": "own profile directory",         "env": {},
    "configDir": "C:/Users/you/.claude-tertiary" }
]
```

### 2 · Credential it (NOT committed) — pick ONE of three ways per account

| way | how | when |
|---|---|---|
| **ambient** | nothing — the account uses whatever `claude` is logged in as on this machine | your main personal login |
| **token** | put an OAuth token in the secrets file (get one with `claude setup-token` while logged in to THAT account) | headless / second account, simplest |
| **configDir** | `"configDir": "<dir>"` in the config → the worker runs with `CLAUDE_CONFIG_DIR=<dir>` (`claude-adapter.ts:458`), a fully separate login profile. Log it in once: `CLAUDE_CONFIG_DIR=<dir> claude login` | keeping accounts hermetically apart, MCP/config per account |

```jsonc
// spicyspec.runner.secrets.json — keyed by account id; only `env` is read
{
  "secondary": { "env": { "CLAUDE_CODE_OAUTH_TOKEN": "..." } },
  "tertiary":  { "env": {} }
}
```

Any variable under `env` is spread into that account's worker process (`claude-adapter.ts:450`), so
provider-specific variables ride the same mechanism.

## What the pool does with them — you configure nothing else

- **Rotation is within a spec**, single-writer: the runner leases ONE account per run
  (pid-carrying lease in the store; a lease whose holder died is broken automatically).
- **Weekly accounts are held in reserve.** The pool OBSERVES each account's limit type from the
  provider's own stream (`five_hour` / `seven_day`, `accounts.ts`) — you do not declare it — and
  `pickOrder` spends five-hour accounts first. MEASURED reason: sorted by uses alone, a warm weekly
  account with zero uses out-ranked every five-hour account and the week's quota went to ordinary
  runs.
- **Refusals sideline, they never park work.** An account whose subscription lapses
  (`EXIT.ACCOUNT_REFUSED`) is cooled for 6h and the SAME run retries on the next account —
  infrastructure must not punish the work. Rate limits mark the account cold until its window
  resets; `allowed_warning` at ~90% utilization is NOT a refusal and keeps serving.
- **The dashboard shows all of it**: per-account warmth, utilization, window reset times, and which
  account the live run holds.

## Checklist for adding account N

1. Add the `{ id, label, env: {}, configDir }` row to `accounts` in `spicyspec.runner.json`.
2. Credential it one of the three ways above; token goes in `spicyspec.runner.secrets.json`.
3. Confirm the secrets file is untracked: `git check-ignore spicyspec.runner.secrets.json`.
4. Restart the runner (or let the supervision sweep do it). The pool picks the account up on the
   next rotation — the dashboard's Accounts panel is the proof it registered.

## Traps

- ⚠️ The secrets file is derived from the CONFIG path. `--config foo.json` → `foo.secrets.json`.
- ⚠️ A missing secrets file is not an error — every account silently falls back to ambient
  credentials, which means TWO account rows can be the SAME human account without noticing. The
  dashboard's per-account usage curves are how you catch it (identical windows = same account).
- ⚠️ Do not reuse one `configDir` across two account rows — the second login evicts the first.
- ⚠️ Tokens expire/revoke on password change; a refused account shows as `EXIT.ACCOUNT_REFUSED`
  in the ledger, cooled 6h, with the reason recorded.
