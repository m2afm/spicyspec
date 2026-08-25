/**
 * search.mjs — the fuzzy matcher behind the command palette and the wire's search box.
 *
 * Hand-rolled because there is no npm here. A subsequence matcher with the three bonuses that
 * decide whether a palette feels psychic or feels broken: a match at the start of a word beats
 * one in the middle, a run of consecutive characters beats a scattered one, and an acronym
 * ('otl' → 'Open The Ledger') beats both.
 *
 * Returns highlight ranges as well as a score, so app.html can bold the matched characters —
 * a palette that ranks correctly but shows you no reason why is a palette you stop trusting.
 *
 * Pure. No DOM.
 */

import { isNum, isText } from './format.mjs';

const WORD_BREAK = /[\s\-_./:·>]/;

/**
 * Score `query` against `text`. Returns null when the query is not a subsequence at all —
 * a non-match must be absent from the list, never a zero-scored row padding the results.
 */
export function fuzzyScore(query, text) {
  const q = isText(query) ? query.trim().toLowerCase() : '';
  const t = isText(text) ? text : '';
  if (!q) return { score: 0, ranges: [] };
  if (!t) return null;
  const lower = t.toLowerCase();

  // Exact substring is not merely the best fuzzy match, it is a different class of match —
  // it jumps a whole tier so typing a full word never ranks under a clever subsequence.
  const direct = lower.indexOf(q);
  if (direct >= 0) {
    const atStart = direct === 0 || WORD_BREAK.test(t[direct - 1]);
    return { score: 1000 + (atStart ? 200 : 0) + Math.max(0, 60 - direct), ranges: [[direct, direct + q.length]] };
  }

  let ti = 0;
  let score = 0;
  let run = 0;
  const ranges = [];
  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    let found = -1;
    while (ti < lower.length) {
      if (lower[ti] === ch) { found = ti; break; }
      ti += 1;
    }
    if (found < 0) return null;                  // not a subsequence: not a match at all

    const prev = found > 0 ? t[found - 1] : null;
    const atWordStart = found === 0 || (prev != null && WORD_BREAK.test(prev));
    const camel = prev != null && prev === prev.toLowerCase() && t[found] === t[found].toUpperCase() && t[found] !== t[found].toLowerCase();

    if (atWordStart) score += 30;
    else if (camel) score += 20;
    else score += 4;

    run = ranges.length && ranges[ranges.length - 1][1] === found ? run + 1 : 0;
    score += run * 12;                           // consecutive characters compound
    score -= Math.min(12, found - (ranges.length ? ranges[ranges.length - 1][1] : 0));

    if (ranges.length && ranges[ranges.length - 1][1] === found) ranges[ranges.length - 1][1] = found + 1;
    else ranges.push([found, found + 1]);
    ti = found + 1;
  }
  // Short targets win ties: 'Theme' should beat 'Open the raw ledger' for 'the'.
  score += Math.max(0, 40 - t.length / 2);
  return { score, ranges };
}

/**
 * Search a list of items across weighted fields. Each item declares its fields once, in the
 * palette source, so ranking rules live in one place rather than per call site.
 *
 *   search(items, 'led', { fields: [['label', 1], ['group', 0.4], ['keywords', 0.3]] })
 */
export function search(items, query, opts = {}) {
  const fields = Array.isArray(opts.fields) && opts.fields.length ? opts.fields : [['label', 1]];
  const q = isText(query) ? query.trim() : '';
  const limit = isNum(opts.limit) ? opts.limit : 40;
  const list = Array.isArray(items) ? items : [];

  if (!q) {
    // No query: the palette shows what it thinks you want, by the source's own priority.
    return list
      .slice()
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .slice(0, limit)
      .map((item) => ({ item, score: 0, ranges: [], field: null }));
  }

  const scored = [];
  for (const item of list) {
    let best = null;
    for (const [field, weight] of fields) {
      const raw = item && item[field];
      const text = Array.isArray(raw) ? raw.join(' ') : raw;
      const hit = fuzzyScore(q, text);
      if (!hit) continue;
      const weighted = hit.score * (isNum(weight) ? weight : 1);
      if (!best || weighted > best.score) best = { score: weighted, ranges: field === fields[0][0] ? hit.ranges : [], field };
    }
    if (!best) continue;
    scored.push({ item, score: best.score + (item.priority || 0), ranges: best.ranges, field: best.field });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Split a label into matched and unmatched parts, so app.html can render the highlight without
 * ever touching innerHTML — the room has no sanitiser and never needs one.
 */
export function highlight(text, ranges) {
  const t = isText(text) ? text : '';
  const rs = (Array.isArray(ranges) ? ranges : []).filter((r) => Array.isArray(r) && r.length === 2).sort((a, b) => a[0] - b[0]);
  if (!rs.length) return [{ text: t, hit: false }];
  const out = [];
  let cursor = 0;
  for (const [a, b] of rs) {
    if (a > cursor) out.push({ text: t.slice(cursor, a), hit: false });
    out.push({ text: t.slice(a, b), hit: true });
    cursor = b;
  }
  if (cursor < t.length) out.push({ text: t.slice(cursor), hit: false });
  return out.filter((p) => p.text.length > 0);
}

/**
 * Group ranked results by their `group` field, preserving rank order inside and between
 * groups. The palette renders headers off this.
 */
export function groupResults(results) {
  const groups = [];
  const byKey = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    const key = (r.item && r.item.group) || 'OTHER';
    let g = byKey.get(key);
    if (!g) { g = { key, items: [] }; byKey.set(key, g); groups.push(g); }
    g.items.push(r);
  }
  return groups;
}
