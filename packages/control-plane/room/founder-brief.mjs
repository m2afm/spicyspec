/**
 * The founder's brief: what only a human can do, turned into a checklist.
 *
 * "Owed by you" listed three specs and five sentences. It named a debt without ever saying
 * what paying it involves — so the fastest exit-bar item in the project was also the least
 * specified, and it has blocked the loop for three specs running.
 *
 * Everything needed is already written down, by the loop, in the repo:
 *
 *   the spec's spec.md      "### User Story N — title (Priority: Pn)" with a narrative, an
 *                           Independent Test, and numbered Given/When/Then acceptance
 *                           scenarios. Those scenarios ARE the manual assertions.
 *                           FR text names its routes and says which must be "reachable by
 *                           navigation (no typed URL)".
 *   .specify/loop/PARKED.md per item: why the loop cannot do it, what unblocks it, and the
 *                           decision it forces at sign-off.
 *   docs/dev-setup.md       the canonical procedure for getting the thing running.
 *
 * So nothing here is invented. Every check carries a `source` naming the file and line it
 * came from, because a checklist a founder cannot audit is worth no more than the assertion
 * that the work is done — and this project has already been burned twice by exactly that.
 *
 * When a document cannot be parsed, this module says so in `problems` and emits fewer checks.
 * It never fabricates a plausible step to fill a gap: an empty checklist is a bug you can
 * see, and a fabricated one is a sign-off you cannot trust.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { splitLines } from './lines.mjs';

/* ------------------------------------------------------------------ helpers ---- */

// splitLines, never split('\n'): every parser below is `$`-anchored, and a CRLF file leaves a
// \r that JS regex treats as a line terminator — so `$` can never match and the parser returns
// nothing, with no error. That is exactly how parseParked silently went from 6 items to 0.
const readLines = (path) => (existsSync(path) ? splitLines(readFileSync(path, 'utf8')) : null);

/** Provenance for a claim. Line numbers are 1-based, as an editor shows them. */
const src = (file, line) => ({ file, line: line + 1 });

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Strip the markdown emphasis the specs use, keeping the words. */
const plain = (s) => clean(s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/`(.+?)`/g, '$1');

/* ------------------------------------------------------------------- specs ---- */

export function specDirFor(root, id) {
  const specs = join(root, 'specs');
  if (!existsSync(specs)) return null;
  const hit = readdirSync(specs).find((d) => d.startsWith(id + '-'));
  return hit ? join('specs', hit) : null;
}

/**
 * Parse the parts of a spec a human tester needs.
 *
 * Deliberately tolerant about ordering and strict about shape: a heading that does not match
 * the documented form is reported as a problem rather than guessed at.
 */
export function parseSpec(root, id) {
  const dir = specDirFor(root, id);
  if (!dir) return { dir: null, problems: ['no specs/' + id + '-* directory exists'] };
  const file = dir + '/spec.md';
  const lines = readLines(join(root, file));
  if (!lines) return { dir, problems: [file + ' does not exist'] };

  const problems = [];
  let title = null;
  const stories = [];
  const routes = new Map();          // route -> first source
  const navRules = [];               // FRs that demand navigation rather than a typed URL

  let cur = null;
  const pushStory = () => { if (cur) stories.push(cur); cur = null; };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const t = line.match(/^#\s+Feature Specification:\s*(.+)$/);
    if (t) { title = plain(t[1]); continue; }

    const us = line.match(/^###\s+User Story\s+(\d+)\s*[—–-]\s*(.+?)\s*\(Priority:\s*(P\d)\)\s*$/);
    if (us) {
      pushStory();
      cur = {
        n: Number(us[1]), title: plain(us[2]), priority: us[3],
        source: src(file, i), narrative: null, independentTest: null, scenarios: [],
      };
      continue;
    }
    // A new section of any other kind ends the current story.
    if (cur && /^#{1,3}\s/.test(line) && !/^###\s+User Story/.test(line)) pushStory();

    if (cur) {
      const it = line.match(/^\*\*Independent Test\*\*:\s*(.+)$/);
      if (it) { cur.independentTest = plain(it[1]); continue; }
      if (/^\*\*Why this priority\*\*:/.test(line) || /^\*\*Acceptance Scenarios\*\*:/.test(line)) continue;

      const sc = line.match(/^(\d+)\.\s+(.*\*\*Given\*\*.*)$/);
      if (sc) {
        cur.scenarios.push({ n: Number(sc[1]), text: plain(sc[2]), raw: sc[2], source: src(file, i) });
        continue;
      }
      // First prose line after the heading is the journey in one sentence.
      if (!cur.narrative && line.trim() && !/^\*\*/.test(line) && !/^\d+\./.test(line)) {
        cur.narrative = plain(line);
      }
    }

    // Routes and the navigation rule, from requirement text anywhere in the file.
    if (/^- \*\*FR-/.test(line)) {
      for (const m of line.matchAll(/`(\/[A-Za-z0-9\-_/:?=&.]*)`/g)) {
        const route = m[1];
        if (!routes.has(route)) routes.set(route, src(file, i));
      }
      if (/reachable by navigation|no typed URL/i.test(line)) {
        const fr = (line.match(/\*\*(FR-[\d.]+)\*\*/) ?? [])[1] ?? 'FR';
        navRules.push({ fr, text: plain(line.replace(/^- /, '')), source: src(file, i) });
      }
    }
  }
  pushStory();

  if (!title) problems.push(file + ': no "# Feature Specification:" heading found');
  if (stories.length === 0) problems.push(file + ': no "### User Story N — title (Priority: Pn)" sections found');
  for (const s of stories) {
    if (s.scenarios.length === 0) problems.push(file + ':' + (s.source.line) + ': user story ' + s.n + ' has no Given/When/Then acceptance scenarios');
  }

  return { dir, file, title, stories, routes: [...routes].map(([r, s]) => ({ route: r, source: s })), navRules, problems };
}

/* ------------------------------------------------------------------ parked ---- */

/**
 * PARKED.md, as records rather than as prose.
 *
 * Headings are not written to one format — some use `·`, one uses a hyphen, one carries a
 * full ISO timestamp — so the separator is matched loosely and the date is kept separately
 * instead of being left glued to the reason.
 */
export function parseParked(root, relPath = '.specify/loop/PARKED.md') {
  const lines = readLines(join(root, relPath));
  if (!lines) return { items: [], problems: [relPath + ' does not exist'] };

  const items = [];
  const problems = [];
  let cur = null;
  let field = null;

  const flush = () => { if (cur) items.push(cur); cur = null; field = null; };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const head = line.match(/^##\s+(.+)$/);
    if (head) {
      flush();
      const raw = clean(head[1]);
      const dm = raw.match(/^(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?)\s*[·\-—]\s*([\s\S]*)$/);
      cur = {
        key: 'parked-' + i,
        date: dm ? dm[1].slice(0, 10) : null,
        reason: dm ? plain(dm[2]) : plain(raw),
        spec: null, why: null, unblocks: null, decision: null,
        source: src(relPath, i),
      };
      continue;
    }
    if (!cur) continue;

    const f = line.match(/^-\s+\*\*(.+?)\*\*:\s*(.*)$/);
    if (f) {
      const name = f[1].toLowerCase();
      field =
        name === 'spec' ? 'spec'
          : name.startsWith('why') ? 'why'
            : name.startsWith('what unblocks') ? 'unblocks'
              : name.startsWith('the decision') ? 'decision'
                : null;
      if (field) cur[field] = plain(f[2]);
      continue;
    }
    // Continuation of the current field: these entries wrap across several lines.
    if (field && /^\s{2,}\S/.test(line) && cur[field] != null) cur[field] += ' ' + plain(line);
    else if (!/^\s*$/.test(line) && !/^-\s/.test(line)) field = null;
  }
  flush();

  for (const it of items) {
    if (!it.unblocks) problems.push(relPath + ':' + it.source.line + ': "' + it.reason.slice(0, 40) + '" records no "what unblocks it"');
  }
  return { items, problems };
}

/* ------------------------------------------------------- prerequisites ---- */

/** The numbered steps of the canonical setup procedure, with their commands. */
export function parseSetup(root, relPath = 'docs/dev-setup.md') {
  const lines = readLines(join(root, relPath));
  if (!lines) return { steps: [], problems: [relPath + ' does not exist'] };
  const steps = [];
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\d+)\.\s+\*\*(.+?)\*\*\s*(.*)$/);
    if (m) {
      if (cur) steps.push(cur);
      cur = { n: Number(m[1]), title: plain(m[2]), detail: plain(m[3]), commands: [], source: src(relPath, i) };
    } else if (cur && /^##\s/.test(lines[i])) {
      steps.push(cur); cur = null;
    } else if (cur && lines[i].trim()) {
      cur.detail += ' ' + plain(lines[i]);
    }
    const target = cur ?? steps[steps.length - 1];
    if (target) {
      // Whitespace after the tool name is required, or `pnpm-workspace.yaml` reads as a
      // command to run — which it is not, and offering it as one would waste a founder's time.
      for (const c of lines[i].matchAll(/`((?:pnpm|npm|npx|nx|docker)\s+[^`]*)`/g)) {
        if (!target.commands.includes(c[1])) target.commands.push(c[1]);
      }
    }
  }
  if (cur) steps.push(cur);
  return { steps, problems: steps.length ? [] : [relPath + ': no numbered "N. **Title**" steps found'] };
}

/* ------------------------------------------------------------------ brief ---- */

/**
 * The non-negotiable rules, quoted from the project's own working agreement rather than
 * invented here. Rule 6 is the whole reason this screen exists.
 */
const DONE_BAR = [
  {
    key: 'bar-navigation',
    title: 'Reach the feature by clicking, never by typing a URL',
    detail: 'Navigate from the app shell as a real user would. A typed URL proves the page renders; it does not prove the page is reachable, and the unreachable-screen class is the only defect this check has ever caught.',
    source: { file: 'CLAUDE.md', line: null, note: 'workflow economics, rule 6' },
  },
  {
    key: 'bar-primary-action',
    title: 'Complete the primary action, not just the page',
    detail: 'Submit the form, publish the listing, pay the invoice — whatever the feature exists to do. Reaching the screen is half the journey.',
    source: { file: 'CLAUDE.md', line: null, note: 'workflow economics, rule 6' },
  },
];

/**
 * Build the brief for one owed item.
 *
 * `kind` is 'spec' for a spec awaiting its founder journey, or 'parked' for an item from
 * PARKED.md. They need different briefs: a spec needs a journey to walk, a parked item needs
 * something supplied and a decision made.
 */
export function buildBrief(root, { kind, id, parkedKey }) {
  if (kind === 'parked') return parkedBrief(root, parkedKey);
  return specBrief(root, id);
}

function specBrief(root, id) {
  const spec = parseSpec(root, id);
  const parked = parseParked(root);
  const setup = parseSetup(root);
  const problems = [...(spec.problems ?? []), ...parked.problems, ...setup.problems];

  // Parked items naming this spec are decisions the founder must take AT sign-off, so they
  // belong in this brief rather than only in their own.
  const related = parked.items.filter((p) => p.spec && new RegExp('\\b' + id + '\\b').test(p.spec));

  const sections = [];

  if (setup.steps.length) {
    sections.push({
      key: 'setup',
      title: 'Before you start — get it running',
      note: 'The canonical procedure. Skip any step already true on this machine.',
      checks: setup.steps.map((s) => ({
        key: 'setup-' + s.n,
        title: s.title,
        detail: s.detail.slice(0, 400),
        commands: s.commands,
        source: s.source,
      })),
    });
  }

  sections.push({
    key: 'bar',
    title: 'The rules that make this count',
    note: 'These are the project\'s own conditions for DONE, not advice.',
    checks: DONE_BAR.map((r) => ({ ...r })),
  });

  if (spec.routes?.length) {
    sections.push({
      key: 'routes',
      title: 'Where this feature lives',
      note: 'Routes named by the spec\'s own requirements. Reach them by navigation — the list is here so you can tell whether you ended up in the right place, not so you can type it.',
      checks: spec.routes.slice(0, 10).map((r, i) => ({
        key: 'route-' + i,
        title: r.route,
        detail: 'Confirm this route is reachable by clicking through the app shell.',
        source: r.source,
      })),
    });
  }

  for (const story of spec.stories ?? []) {
    sections.push({
      key: 'us' + story.n,
      title: 'Journey ' + story.n + ' — ' + story.title,
      priority: story.priority,
      note: story.narrative,
      independentTest: story.independentTest,
      source: story.source,
      checks: story.scenarios.map((sc) => ({
        key: 'us' + story.n + '-s' + sc.n,
        title: 'Scenario ' + sc.n,
        detail: sc.text,
        given: splitGwt(sc.raw),
        source: sc.source,
      })),
    });
  }

  if (related.length) {
    sections.push({
      key: 'decisions',
      title: 'Decisions this sign-off forces',
      note: 'Parked items naming this spec. Each is a founder call the loop is forbidden from making.',
      checks: related.map((p, i) => ({
        key: 'decision-' + i,
        title: p.reason,
        detail: [p.decision, p.unblocks && 'What would unblock it: ' + p.unblocks].filter(Boolean).join(' — '),
        source: p.source,
      })),
    });
  }

  const total = sections.reduce((n, s) => n + s.checks.length, 0);
  return {
    kind: 'spec',
    id,
    title: spec.title ?? ('Spec ' + id),
    specDir: spec.dir,
    headline: 'Spec ' + id + ' is built but unverified. It needs a clicked founder journey.',
    why: 'A script can reach a URL, and it cannot tell you the feature was findable. Every automated gate on this spec has already passed; what is missing is a human completing the journey by navigation.',
    sections,
    total,
    problems,
  };
}

/** Split a Given/When/Then sentence into its clauses, for a readable step. */
function splitGwt(raw) {
  const g = raw.match(/\*\*Given\*\*\s*([\s\S]*?)(?=\*\*When\*\*|\*\*Then\*\*|$)/);
  const w = raw.match(/\*\*When\*\*\s*([\s\S]*?)(?=\*\*Then\*\*|$)/);
  const t = raw.match(/\*\*Then\*\*\s*([\s\S]*)$/);
  const strip = (s) => (s ? plain(s).replace(/^[,\s]+|[,\s]+$/g, '') : null);
  return { given: strip(g?.[1]), when: strip(w?.[1]), then: strip(t?.[1]) };
}

function parkedBrief(root, parkedKey) {
  const parked = parseParked(root);
  const item = parked.items.find((p) => p.key === parkedKey);
  if (!item) return { kind: 'parked', id: parkedKey, title: 'Unknown parked item', sections: [], total: 0, problems: ['no parked item with key ' + parkedKey] };

  const checks = [];
  if (item.unblocks) {
    checks.push({ key: 'unblock', title: 'Supply what unblocks it', detail: item.unblocks, source: item.source });
  }
  if (item.decision) {
    checks.push({ key: 'decide', title: 'Take the decision it forces', detail: item.decision, source: item.source });
  }
  if (!checks.length) {
    checks.push({
      key: 'read',
      title: 'Read the entry and decide what it needs',
      detail: 'This item records no "what unblocks it" line, so there is nothing here to turn into steps. That is a gap in PARKED.md, not a step you can tick past.',
      source: item.source,
    });
  }

  return {
    kind: 'parked',
    id: parkedKey,
    title: item.reason,
    headline: item.reason,
    why: item.why ?? 'Recorded in PARKED.md as something the loop must not solve itself.',
    affectsSpec: item.spec,
    recordedOn: item.date,
    sections: [{ key: 'parked', title: 'What this needs from you', note: item.why, checks }],
    total: checks.length,
    problems: parked.problems.filter((p) => p.includes(String(item.source.line))),
  };
}

/** Every owed item the dashboard should offer a brief for. */
export function listOwed(root, queueEntries) {
  const owedSpecs = (queueEntries ?? []).filter((e) => e.status === 'awaiting-founder');
  const parked = parseParked(root);
  return [
    ...owedSpecs.map((e) => ({ kind: 'spec', id: e.id, key: 'spec-' + e.id, title: 'Spec ' + e.id + ' — clicked founder journey' })),
    ...parked.items.map((p) => ({ kind: 'parked', id: p.key, key: p.key, title: p.reason, affectsSpec: p.spec, recordedOn: p.date })),
  ];
}
