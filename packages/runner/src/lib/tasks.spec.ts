import { describe, expect, it } from 'vitest';
import { countTasks } from './tasks.js';

describe('DEFERRED-TO-<spec> rows do not hold a spec open', () => {
  it('a deferred row counts as neither done nor open', () => {
    // 008 was cut to a testable exit bar and 26 rows were marked for 009, left in place for
    // traceability. They promptly became a SECOND infinity loop: R15 flips converge ->
    // execute while any row is open, and those 26 would never close. A rule that ends one
    // spiral must not create the next.
    const c = countTasks(
      [
        '- [x] **T001** done thing',
        '- [ ] **T002** real open work',
        '- [ ] T036b **DEFERRED-TO-009** the whole listings surface',
        '- [ ] **T042** **DEFERRED-TO-009** admin page',
      ].join('\n'),
    );
    expect(c).toMatchObject({ done: 1, open: 1, deferred: 2 });
    expect(c.nextTaskIds).toEqual(['T002']);
  });

  it('needs the shouty marker with a target — prose about deferring retires nothing', () => {
    const c = countTasks(
      [
        '- [ ] **T003** we may defer this later, deferred to 009 perhaps',
        '- [ ] **T004** DEFERRED (no target)',
      ].join('\n'),
    );
    expect(c).toMatchObject({ open: 2, deferred: 0 });
  });

  it('still counts a plain (unbolded) id, as the live tasks.md writes them', () => {
    expect(countTasks('- [ ] T036c the single-listing read')).toMatchObject({ open: 1 });
  });
});
