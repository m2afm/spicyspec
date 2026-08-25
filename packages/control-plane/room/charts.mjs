/**
 * charts.mjs — every curve on the deck, hand-rolled.
 *
 * There is no chart library here and there never will be: the room is one vendored file that
 * must work with the network unplugged. So this module returns SVG path strings and plain
 * geometry, and app.html turns them into <path d=…> with token strokes.
 *
 * The rule that makes these charts honest: A GAP IS DRAWN AS A GAP. A series with a missing
 * sample breaks the line and reports the hole in `gaps`; it never interpolates across it,
 * because a smooth curve over an hour nobody measured is exactly the picture that tells a
 * founder everything was fine while nothing was happening.
 *
 * Pure. No colours (R5 — colour is a token chosen in app.html's stylesheet), no DOM.
 */

import { isNum } from './format.mjs';

/** SVG wants short decimals or the path strings triple in size for sub-pixel nonsense. */
const n = (v) => (Math.round(v * 100) / 100).toString();

/**
 * Domain of a series, ignoring holes. `min`/`max` are null when nothing is measurable —
 * the caller must then render the hatch, not a flat line at zero.
 */
export function extent(values) {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const v of values || []) {
    if (!isNum(v)) continue;
    count += 1;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (count === 0) return { min: null, max: null, count: 0 };
  return { min, max, count };
}

/**
 * Map a series into a box. Returns one point per input — holes become `{ x, y: null }` so the
 * path builder can lift the pen and the caller can mark the gap.
 *
 * `baseline: 'zero'` anchors the floor at 0 (the right choice for counts and money, where a
 * min-anchored axis exaggerates a rise from 40 to 42 into a cliff). Default is min-anchored
 * for rate-like series where the shape is the point.
 */
export function scale(values, opts = {}) {
  const list = Array.isArray(values) ? values : [];
  const w = isNum(opts.width) ? opts.width : 100;
  const h = isNum(opts.height) ? opts.height : 24;
  const pad = isNum(opts.pad) ? opts.pad : 1;
  const { min, max, count } = extent(list);

  if (count === 0) return { points: list.map((_, i) => ({ x: 0, y: null, i })), min: null, max: null, count: 0, width: w, height: h };

  let lo = opts.baseline === 'zero' ? Math.min(0, min) : min;
  let hi = isNum(opts.max) ? opts.max : max;
  if (hi === lo) { hi = lo + 1; }               // a flat series is a line through the middle,
  const span = hi - lo;                          // not a divide-by-zero.
  const usable = Math.max(1, h - pad * 2);
  const step = list.length > 1 ? w / (list.length - 1) : 0;

  const points = list.map((v, i) => ({
    i,
    x: list.length > 1 ? i * step : w / 2,
    y: isNum(v) ? pad + usable - ((v - lo) / span) * usable : null,
    v: isNum(v) ? v : null,
  }));
  return { points, min: lo, max: hi, count, width: w, height: h };
}

/**
 * A sparkline. Returns `{ d, gaps, count }` — `d` is one or more M…L runs, one run per
 * unbroken stretch of real samples, and `gaps` names the index ranges the line skipped so the
 * caller can hatch them.
 */
export function sparkPath(values, opts = {}) {
  const s = scale(values, opts);
  const segments = [];
  const gaps = [];
  let run = [];
  let gapStart = null;

  for (const p of s.points) {
    if (p.y == null) {
      if (run.length) { segments.push(run); run = []; }
      if (gapStart == null) gapStart = p.i;
      continue;
    }
    if (gapStart != null) { gaps.push({ from: gapStart, to: p.i - 1 }); gapStart = null; }
    run.push(p);
  }
  if (run.length) segments.push(run);
  if (gapStart != null) gaps.push({ from: gapStart, to: s.points.length - 1 });

  const d = segments
    .map((seg) => (seg.length === 1
      // One lone sample is a tick mark, not a line — a 1px horizontal stub, so a single
      // priced run still shows rather than vanishing into an empty box.
      ? `M${n(seg[0].x - 1)} ${n(seg[0].y)}L${n(seg[0].x + 1)} ${n(seg[0].y)}`
      : `M${seg.map((p, i) => `${i ? 'L' : ''}${n(p.x)} ${n(p.y)}`).join('')}`))
    .join('');

  return { d, gaps, count: s.count, min: s.min, max: s.max, width: s.width, height: s.height, points: s.points };
}

/**
 * The same line closed to the floor, for a filled sparkline. Only ever built per unbroken
 * segment — a fill that spans a hole would colour in time nobody watched.
 */
export function areaPath(values, opts = {}) {
  const spark = sparkPath(values, opts);
  const floor = spark.height - (isNum(opts.pad) ? opts.pad : 1);
  const runs = spark.d.split('M').filter(Boolean);
  const d = runs.map((run) => {
    const coords = run.trim().split('L').map((c) => c.trim().split(' ').map(Number));
    if (!coords.length) return '';
    const first = coords[0];
    const last = coords[coords.length - 1];
    return `M${n(first[0])} ${n(floor)}L${run}L${n(last[0])} ${n(floor)}Z`;
  }).join('');
  return { ...spark, d: spark.d, areaD: d, floor };
}

/**
 * The CADENCE STRIP: 60 discrete bars, one per state push. Bars are returned as rects, not a
 * path, so a zero-movement frame can be drawn as a visible floor tick rather than as nothing —
 * "no movement" and "no data" must not look the same.
 */
export function barsRects(values, opts = {}) {
  const list = Array.isArray(values) ? values : [];
  const w = isNum(opts.width) ? opts.width : 240;
  const h = isNum(opts.height) ? opts.height : 22;
  const gap = isNum(opts.gap) ? opts.gap : 1;
  const floor = isNum(opts.floorPx) ? opts.floorPx : 1;
  const slot = list.length ? w / list.length : w;
  const bw = Math.max(0.5, slot - gap);
  const { max } = extent(list);
  const top = isNum(opts.max) ? opts.max : (isNum(max) ? Math.max(max, 1) : 1);

  return list.map((v, i) => {
    const known = isNum(v);
    const height = known ? Math.max(v > 0 ? floor + 1 : floor, (v / top) * (h - floor)) : h;
    return {
      i,
      x: i * slot,
      width: bw,
      // An unknown frame fills its whole slot as a hatch band; a known zero shows the floor
      // tick. The founder can tell "the loop did nothing" from "the room saw nothing".
      y: known ? h - height : 0,
      height,
      value: known ? v : null,
      known,
      zero: known && v === 0,
    };
  });
}

/**
 * The RUNWAY timeline (Z1-D): a rate window drawn as time, not as a bar. Returns the
 * now-marker's fraction and the utilization fill.
 *
 * `startedAt` is frequently absent — the server reports `windowEndsAt` and no start. When it
 * is, `known:false` comes back and the whole track hatches; the deck must NOT invent a
 * five-hour window to make the picture pretty.
 */
export function windowTrack(opts = {}) {
  const start = isNum(opts.startedAt) ? opts.startedAt : null;
  const end = isNum(opts.endsAt) ? opts.endsAt : null;
  const now = isNum(opts.now) ? opts.now : Date.now();
  const util = isNum(opts.utilization) ? Math.max(0, Math.min(1, opts.utilization)) : null;

  if (start == null || end == null || end <= start) {
    return {
      known: false,
      nowFraction: null,
      utilization: util,
      remainingMs: end != null ? Math.max(0, end - now) : null,
      reason: start == null ? 'window start not reported' : 'window end not reported',
    };
  }
  const nowFraction = Math.max(0, Math.min(1, (now - start) / (end - start)));
  return {
    known: true,
    nowFraction,
    utilization: util,
    remainingMs: Math.max(0, end - now),
    elapsedMs: Math.max(0, now - start),
    spanMs: end - start,
    // The interesting comparison: is the quota burning faster than the clock? Positive means
    // spending ahead of the window and the founder will hit the wall before it resets.
    pace: util == null ? null : util - nowFraction,
    reason: null,
  };
}

/**
 * The exit-class small multiple: one stacked horizontal band per bucket, widths summing to 1.
 * Buckets with zero rows are dropped rather than drawn as slivers nobody can hit.
 */
export function stackBands(buckets, opts = {}) {
  const rows = (Array.isArray(buckets) ? buckets : []).filter((b) => b && isNum(b.value) && b.value > 0);
  const total = rows.reduce((a, b) => a + b.value, 0);
  const w = isNum(opts.width) ? opts.width : 100;
  if (total <= 0) return { bands: [], total: 0, known: false };
  let x = 0;
  const bands = rows.map((b) => {
    const width = (b.value / total) * w;
    const band = { key: b.key, label: b.label ?? b.key, value: b.value, share: b.value / total, x, width, tone: b.tone ?? null };
    x += width;
    return band;
  });
  return { bands, total, known: true };
}

/**
 * The WATCH RAIL (Z4): 24 hours ruled by hour, newest at TOP, with the observed / gap bands
 * the coverage computation produced. Returns y-positions in a 0..height box.
 *
 * `newestAtTop` is the deck's choice and is not negotiable in the layout — but it is a flag
 * here so the same geometry can serve a horizontal ticker later without a second copy.
 */
export function railGeometry(opts = {}) {
  const now = isNum(opts.now) ? opts.now : Date.now();
  const spanMs = isNum(opts.spanMs) ? opts.spanMs : 24 * 3_600_000;
  const height = isNum(opts.height) ? opts.height : 600;
  const start = now - spanMs;

  const at = (t) => {
    if (!isNum(t)) return null;
    const clamped = Math.max(start, Math.min(now, t));
    const frac = (now - clamped) / spanMs;         // 0 = now = top
    return opts.newestAtTop === false ? height - frac * height : frac * height;
  };

  const hourRules = [];
  const firstHour = new Date(now);
  firstHour.setMinutes(0, 0, 0);
  for (let t = firstHour.getTime(); t > start; t -= 3_600_000) {
    hourRules.push({ at: t, y: at(t), hour: new Date(t).getHours() });
  }

  return {
    start,
    now,
    spanMs,
    height,
    at,
    hourRules,
    /** A time span as a band on the rail; used for both coverage gaps and long runs. */
    band(from, to) {
      const a = at(from);
      const b = at(to);
      if (a == null || b == null) return null;
      const y = Math.min(a, b);
      return { y, height: Math.max(1, Math.abs(b - a)) };
    },
  };
}

/**
 * A ring gauge for the SPEC LADDER cells and the account with least headroom. Returns an arc
 * path over a circle. Fraction is clamped; an unknown fraction returns `d: null` so the caller
 * draws the empty ring and the '?' rather than a full circle that reads as complete.
 */
export function arcPath(fraction, opts = {}) {
  const cx = isNum(opts.cx) ? opts.cx : 12;
  const cy = isNum(opts.cy) ? opts.cy : 12;
  const r = isNum(opts.r) ? opts.r : 10;
  if (!isNum(fraction)) return { d: null, known: false, fraction: null };
  const f = Math.max(0, Math.min(1, fraction));
  if (f <= 0) return { d: null, known: true, fraction: 0 };
  if (f >= 1) {
    // A full circle cannot be one arc — two halves, or the renderer draws nothing.
    return { d: `M${n(cx)} ${n(cy - r)}A${n(r)} ${n(r)} 0 1 1 ${n(cx)} ${n(cy + r)}A${n(r)} ${n(r)} 0 1 1 ${n(cx)} ${n(cy - r)}`, known: true, fraction: 1 };
  }
  const angle = f * Math.PI * 2 - Math.PI / 2;
  const x = cx + r * Math.cos(angle);
  const y = cy + r * Math.sin(angle);
  return { d: `M${n(cx)} ${n(cy - r)}A${n(r)} ${n(r)} 0 ${f > 0.5 ? 1 : 0} 1 ${n(x)} ${n(y)}`, known: true, fraction: f };
}

/**
 * A LADDER cell's fill, as a rect that grows from the bottom. Separate from arcPath because
 * 22 cells at 14px wide read better as filled columns than as rings.
 */
export function fillRect(fraction, opts = {}) {
  const w = isNum(opts.width) ? opts.width : 14;
  const h = isNum(opts.height) ? opts.height : 34;
  if (!isNum(fraction)) return { x: 0, y: 0, width: w, height: h, known: false };
  const f = Math.max(0, Math.min(1, fraction));
  const fh = f * h;
  return { x: 0, y: h - fh, width: w, height: fh, known: true, fraction: f };
}

/**
 * The median. Used everywhere an average would have been reached for — one $59 run drags a
 * mean of sixteen runs past every honest reading of "typical", and the anomaly cards compare
 * against typical.
 */
export function median(values) {
  const list = (Array.isArray(values) ? values : []).filter(isNum).slice().sort((a, b) => a - b);
  if (!list.length) return null;
  const mid = list.length >> 1;
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

/** Sum that returns null for an empty set — because `0` would be a claim we did not measure. */
export function sum(values) {
  const list = (Array.isArray(values) ? values : []).filter(isNum);
  if (!list.length) return null;
  return list.reduce((a, b) => a + b, 0);
}

/** Mean with the same rule. Paired with its n by every caller. */
export function mean(values) {
  const list = (Array.isArray(values) ? values : []).filter(isNum);
  if (!list.length) return null;
  return list.reduce((a, b) => a + b, 0) / list.length;
}
