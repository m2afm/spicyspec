/**
 * What the founder has actually ticked off, and what that adds up to.
 *
 * Kept in its own file rather than in QUEUE.json for one reason: the driver is the only
 * writer of the queue, and it must stay that way. A dashboard writing the queue while the
 * driver holds a tick would be two writers on one file, which is the exact hazard the lock
 * exists to prevent. So the founder's progress lives here, sign-off is stated in git as a
 * tag, and the driver reconciles its own file from that tag on its own schedule.
 *
 * The file is written atomically (temp + rename) because it is read by a page that polls: a
 * half-written JSON object would surface as "your progress is gone".
 */
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';

const EMPTY = { version: 1, items: {} };

export function loadChecks(path) {
  if (!existsSync(path)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.items !== 'object') return structuredClone(EMPTY);
    return parsed;
  } catch {
    // A corrupt file must not lose the founder's work silently, but it also must not crash the
    // page. Returning empty is the honest degradation: the UI shows nothing ticked, which is
    // visibly wrong, rather than showing a wrong subset that looks right.
    return structuredClone(EMPTY);
  }
}

function save(path, state) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  try {
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, JSON.stringify(state, null, 1), 'utf8');
    rmSync(tmp, { force: true });
  }
}

const itemOf = (state, itemKey) => {
  if (!state.items[itemKey]) {
    state.items[itemKey] = { checked: {}, notes: {}, startedAt: null, updatedAt: null, signedOffAt: null };
  }
  return state.items[itemKey];
};

/** Tick or untick one check. Returns the updated item record. */
export function setCheck(path, itemKey, checkKey, value, at = new Date().toISOString()) {
  const state = loadChecks(path);
  const item = itemOf(state, itemKey);
  if (value) {
    // The timestamp is the point: "ticked at 03:14" is evidence, "true" is an opinion.
    item.checked[checkKey] = at;
    if (!item.startedAt) item.startedAt = at;
  } else {
    delete item.checked[checkKey];
  }
  item.updatedAt = at;
  save(path, state);
  return item;
}

/** Attach a note to one check — what the founder saw, in their words. */
export function setNote(path, itemKey, checkKey, text, at = new Date().toISOString()) {
  const state = loadChecks(path);
  const item = itemOf(state, itemKey);
  const trimmed = String(text ?? '').slice(0, 2000).trim();
  if (trimmed) item.notes[checkKey] = trimmed;
  else delete item.notes[checkKey];
  item.updatedAt = at;
  save(path, state);
  return item;
}

/** Record that sign-off happened, alongside the git tag that is its real evidence. */
export function markSignedOff(path, itemKey, at = new Date().toISOString()) {
  const state = loadChecks(path);
  const item = itemOf(state, itemKey);
  item.signedOffAt = at;
  item.updatedAt = at;
  save(path, state);
  return item;
}

export function clearItem(path, itemKey) {
  const state = loadChecks(path);
  delete state.items[itemKey];
  save(path, state);
}

/**
 * Progress for one brief.
 *
 * `blocking` counts only the checks that gate sign-off. Setup steps do not: whether a
 * database is already running says nothing about whether the feature works, and holding
 * sign-off on "did you run pnpm install" would train the founder to tick without reading.
 */
export const NON_BLOCKING_SECTIONS = new Set(['setup', 'routes']);

export function progressFor(state, itemKey, brief) {
  const item = state.items?.[itemKey] ?? { checked: {}, notes: {} };
  const checked = item.checked ?? {};
  let done = 0, total = 0, blockingDone = 0, blockingTotal = 0;
  const remaining = [];

  for (const section of brief.sections ?? []) {
    const blocks = !NON_BLOCKING_SECTIONS.has(section.key);
    for (const check of section.checks) {
      total += 1;
      const isDone = Boolean(checked[check.key]);
      if (isDone) done += 1;
      if (blocks) {
        blockingTotal += 1;
        if (isDone) blockingDone += 1;
        else remaining.push({ section: section.title, key: check.key, title: check.title });
      }
    }
  }
  return {
    done, total, blockingDone, blockingTotal,
    remaining,
    complete: blockingTotal > 0 && blockingDone === blockingTotal,
    startedAt: item.startedAt ?? null,
    signedOffAt: item.signedOffAt ?? null,
    checked,
    notes: item.notes ?? {},
  };
}
