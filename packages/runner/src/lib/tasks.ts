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
  nextTaskIds: string[];
}

/** `- [ ] **T012** …` (open) / `- [x] **T012** …` (done). Indentation allowed. */
const TASK_LINE = /^\s*[-*] \[([ xX])\] \*\*(T\d+)\*\*/;

export function countTasks(text: string | null, nextIdsLimit = 3): TaskCounts {
  if (text === null) return { exists: false, done: 0, open: 0, nextTaskIds: [] };
  let done = 0;
  let open = 0;
  const nextTaskIds: string[] = [];
  for (const line of text.split('\n')) {
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    if (m[1] === ' ') {
      open += 1;
      if (nextTaskIds.length < nextIdsLimit) nextTaskIds.push(m[2]);
    } else {
      done += 1;
    }
  }
  return { exists: true, done, open, nextTaskIds };
}
