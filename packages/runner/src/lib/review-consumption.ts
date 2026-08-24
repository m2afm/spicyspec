/**
 * One recorded review decision, one consumption — shared by BOTH of its consumers.
 *
 * A manager's approve/reject lands in the store as a single row. Two things read it: the
 * workflow bridge (wiring's `checkReviewDecision`, which hands the decision to a run parked
 * on review) and the rotation's promotion pass (queue-activities' `openNextSpec`, which
 * retires the entry). They keyed on DIFFERENT markers — `review:delivered:<id>` and
 * `review:promoted:<id>` — so neither could see that the other had already spent the
 * decision, and the git-tag promotion path wrote no marker at all. A spec re-queued by hand
 * months after an approval was then auto-retired on the next rotation iteration by the
 * approval it had already consumed.
 *
 * One marker now, written by whichever consumer sees the decision first.
 */
import type { Store } from '@spicyspec/store';

export const REVIEW_CONSUMED_KEY = (specId: string) => `review:consumed:${specId}`;

/** The two markers this replaced. Read-only, and only so an upgrade in place does not
 * re-consume a decision an older build already spent. */
const LEGACY_KEYS = [(id: string) => `review:delivered:${id}`, (id: string) => `review:promoted:${id}`];

/**
 * The stamp that identifies THIS decision. A hand-written record with no timestamp still
 * consumes exactly once: falling back to a constant makes the marker match forever after,
 * which errs toward "already credited" rather than re-retiring a re-queued spec on every
 * rotation iteration.
 */
export const decisionStamp = (decision: { at?: string }): string => decision.at || 'undated';

/**
 * True for the FIRST consumer of this decision, false for every consumer after it —
 * including a retried poll of the same one, and including the other consumer.
 */
export async function consumeReviewDecision(
  store: Store,
  specId: string,
  decision: { at?: string },
): Promise<boolean> {
  const stamp = decisionStamp(decision);
  const key = REVIEW_CONSUMED_KEY(specId);
  const held = await store.getKv(key);
  if (held === stamp) return false;
  for (const legacy of LEGACY_KEYS) {
    if ((await store.getKv(legacy(specId))) === stamp) {
      await store.setKv(key, stamp);
      return false;
    }
  }
  // ATOMIC claim, not read-then-write: this function's whole contract is exactly-once, and
  // its two consumers (the workflow bridge and the rotation's promotion pass) can reach it
  // concurrently — a getKv/setKv pair lets both read "unspent" and both spend it.
  // tryReserve is the store's compare-and-set (the same primitive the account leases use).
  if (held !== null) {
    // A DIFFERENT decision is on record (a later approval). Replace it, then claim.
    await store.release(key);
  }
  return store.tryReserve(key, stamp);
}

/**
 * Read-only: has THIS decision already been credited? Lets a caller decide before it
 * mutates, then spend after it has committed that mutation — the ordering that stops a
 * crash from consuming an approval nothing can credit any more.
 */
export async function isReviewDecisionConsumed(
  store: Store,
  specId: string,
  decision: { at?: string },
): Promise<boolean> {
  const stamp = decisionStamp(decision);
  if ((await store.getKv(REVIEW_CONSUMED_KEY(specId))) === stamp) return true;
  for (const legacy of LEGACY_KEYS) {
    if ((await store.getKv(legacy(specId))) === stamp) return true;
  }
  return false;
}

/**
 * Spend whatever decision is on record without acting on it — how the git-TAG promotion
 * path closes the hole. The room's sign-off writes both the tag and the decision, so an
 * entry retired by its tag leaves an unspent decision behind; unless it is marked here,
 * that row is still live evidence the promotion pass will credit to a future re-queue.
 */
export async function markRecordedDecisionConsumed(
  store: Store,
  specId: string,
  decision: { at?: string } | null,
): Promise<void> {
  if (!decision) return;
  await store.setKv(REVIEW_CONSUMED_KEY(specId), decisionStamp(decision));
}
