/**
 * Width-aware text helpers. All pure, all unit-tested. "width" is the character
 * count of the paper column (48 for 80mm Font A, 32 for 58mm).
 */

/** Repeat a char to fill the width (e.g. a divider line). */
export const rule = (width, ch = '-') => ch.repeat(Math.max(0, width));

/** Hard-wrap text to width, breaking long words that don't fit. */
export function wrap(text, width) {
  const out = [];
  for (const rawLine of String(text).split('\n')) {
    let line = '';
    let emitted = false;
    for (const word of rawLine.split(/\s+/).filter(Boolean)) {
      if (word.length > width) {
        // Word longer than the column: flush, then hard-slice it.
        if (line) { out.push(line); line = ''; emitted = true; }
        for (let i = 0; i < word.length; i += width) { out.push(word.slice(i, i + width)); emitted = true; }
        continue;
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else { out.push(line); line = word; emitted = true; }
    }
    // Push the trailing partial line; also push an empty line only when this
    // rawLine produced nothing at all (preserves intentional blank lines).
    if (line !== '' || !emitted) out.push(line);
  }
  return out;
}

/** Center a single line within width (no-op if it doesn't fit). */
export function center(text, width) {
  const s = String(text);
  if (s.length >= width) return s;
  const pad = Math.floor((width - s.length) / 2);
  return ' '.repeat(pad) + s;
}

/**
 * Two-column row: label on the left, value flush right. If the label is too long
 * it wraps; the value stays on the LAST line, right-aligned. Returns >=1 lines.
 */
export function leftRight(left, right, width) {
  const value = String(right ?? '');
  const labelWidth = Math.max(1, width - value.length - 1);
  const lines = wrap(String(left ?? ''), labelWidth);
  if (lines.length === 0) lines.push('');
  const last = lines[lines.length - 1];
  const gap = Math.max(1, width - last.length - value.length);
  lines[lines.length - 1] = last + ' '.repeat(gap) + value;
  return lines;
}

/** Format money with fixed 2 decimals and optional currency prefix. */
export function money(amount, currency = '') {
  const n = Number.isFinite(amount) ? amount : 0;
  const s = n.toFixed(2);
  return currency ? `${currency} ${s}` : s;
}
