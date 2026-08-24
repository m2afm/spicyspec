/**
 * Split file text into lines, tolerating CRLF.
 *
 * `text.split('\n')` on a CRLF file leaves a `\r` on the end of every line, and in JavaScript
 * that is not merely untidy — it silently breaks any regex anchored with `$`:
 *
 *   /^##\s+(.+)$/.test('## heading\r')   // false
 *
 * because `\r` is a LINE TERMINATOR in JS regex, so `.` refuses to match it, `(.+)` stops
 * short, and `$` can never be reached. `/^##/` still passes, which is what makes it so hard to
 * see: the line looks matched right up to the point where it is not.
 *
 * This cost a live bug. PARKED.md was LF, a tool wrote it back as CRLF, and `parseParked`
 * dropped from 6 items to 0 with no error — so the test plan for a shipment silently omitted
 * every "do not report this, it is known" warning. A tester would have spent an afternoon
 * reporting a deliberately faked Stripe provider.
 *
 * It is a live hazard rather than a one-off: git normalises to LF on commit but the working
 * tree can hold CRLF at any moment, and every one of these parsers reads the working tree.
 */

/** Lines with any trailing carriage return removed. Handles LF, CRLF and lone CR files. */
export function splitLines(text) {
  return String(text ?? '').split(/\r\n|\r|\n/);
}

/** One line, with a trailing CR stripped — for code that already has a line in hand. */
export const stripCr = (line) => String(line ?? '').replace(/\r$/, '');
