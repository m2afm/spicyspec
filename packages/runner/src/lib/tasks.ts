/**
 * Task-list counting — checkbox lines carrying a task id, nothing else.
 *
 * The prototype's counter read PROSE as tasks (defect B28: a bulleted explanation matched
 * the pattern and inflated the count), so the rule here is strict: a task line is a
 * markdown checkbox followed by a bold task id. Everything else is prose.
 */

export interface TaskCounts {
  exists: boolean;
  done: number;
  open: number;
  /** rows explicitly moved to a later spec — neither done nor blocking this one */
  deferred: number;
  nextTaskIds: string[];
}

/** `- [ ] **T012** …` (open) / `- [x] **T012** …` (done). Indentation allowed. */
const TASK_LINE = /^\s*[-*] \[([ xX])\] (?:\*\*)?(T\d+[a-z]?)\b/;

/**
 * An explicit hand-off marker, and deliberately shouty: `DEFERRED-TO-<spec>`.
 *
 * A row deferred to a later spec must not hold this one open. When 008's scope was cut to a
 * testable exit bar, 26 rows were marked for 009 and left in place for traceability — and
 * they promptly became a second infinity loop, because R15 flips converge -> execute while
 * any row is open, and those 26 would never close. A rule that ends one spiral must not
 * create the next. The marker must be uppercase and name a target, so prose about deferral
 * can never silently retire real work.
 */
const DEFERRED = /\bDEFERRED-TO-[A-Za-z0-9._-]+/;

export function countTasks(text: string | null, nextIdsLimit = 3): TaskCounts {
  if (text === null) return { exists: false, done: 0, open: 0, deferred: 0, nextTaskIds: [] };
  let done = 0;
  let open = 0;
  let deferred = 0;
  const nextTaskIds: string[] = [];
  for (const line of text.split('\n')) {
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    if (m[1] !== ' ') {
      done += 1;
      continue;
    }
    if (DEFERRED.test(line)) {
      deferred += 1;
      continue;
    }
    open += 1;
    if (nextTaskIds.length < nextIdsLimit) nextTaskIds.push(m[2]);
  }
  return { exists: true, done, open, deferred, nextTaskIds };
}
