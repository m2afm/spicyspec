# control-plane

The Loop Control Room — the founder-facing dashboard — plus the small HTTP surfaces around it.

## Building

Run `nx build control-plane` to build the library.

## Running unit tests

Run `nx test control-plane` to execute the unit tests via [Vitest](https://vitest.dev/).

## The store contract this room reads

The room is a READER. It never writes a supervised process's state; it writes only what the
founder clicks. Two of those keys are shared with the supervisor, so they are pinned here.

### `health:events` — the supervisor's report (supervisor writes, room reads)

Entries are `{ at, check, status, detail? }`:

| field    | meaning                                                                          |
| -------- | -------------------------------------------------------------------------------- |
| `at`     | ISO timestamp of the check                                                       |
| `check`  | `temporal` · `worker` · `rotation` · `dashboard` · `stop-flags` · `leases` · `lock` |
| `status` | `ok` · `repaired` · `failed` · `blocked` (any other word is shown verbatim)       |
| `detail` | one sentence a founder can act on — the repair performed, or why it could not be  |

The room accepts a JSON array, a `{ events: [...] }` envelope, one bare event, or
newline-delimited JSON, and merges **every** `health:*` row — so `health:last-cycle`, whose
envelope carries the ok checks the failures ring deliberately omits, is what puts green rows
on the panel. A repair therefore arrives twice; the room deduplicates on
`at|check|status|detail` so it is narrated once.

A check the supervisor has never reported still gets a panel row reading "not reported"; an
unparseable value yields no events at all, never invented health.

`health:supervisor` carries `{ at, intervalMs, … }` — the supervisor's own heartbeat. Silence
longer than three intervals (default five minutes) is rendered as
`supervisor not reporting — install with: spicyspec-runner install-autostart`.

### `runner:stop` / `runner:kill-now` — the two-level stop (both write)

`{ armedAt, armedBy }`. **The room always stamps `armedBy: 'founder'`.** The supervisor
auto-clears only `armedBy: 'agent'` and never the founder's; a MISSING `armedBy` is treated by
the supervisor as the founder's, because the fail-safe direction is to leave a stop alone.

The room does not make that assumption in what it SHOWS. An unattributed flag is rendered as
armed by an unrecorded author — which is exactly what it is, and exactly the flag that once
halted the loop overnight with nobody able to say who set it.
