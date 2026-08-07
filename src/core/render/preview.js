/**
 * Doc -> plain text. This is the secret weapon: render any receipt to the
 * terminal with no printer attached. Used by `bin/preview.js` and by tests, so
 * layouts are verified as human-readable strings, not opaque bytes.
 *
 * @param {import('./doc.js').Doc} doc
 * @param {{width?:number}} [opts]
 * @returns {string}
 */
import { rule, wrap, center, leftRight } from './format.js';

export function toText(doc, { width = 48 } = {}) {
  const lines = [];
  let align = 'left';
  const put = (s) => {
    if (align === 'center') lines.push(center(s, width));
    else if (align === 'right') lines.push(' '.repeat(Math.max(0, width - s.length)) + s);
    else lines.push(s);
  };
  const cols = (s) => (s?.doubleW ? Math.floor(width / 2) : width);
  const mark = (s, style) => (style?.bold || style?.doubleH || style?.doubleW ? s.toUpperCase() : s);

  for (const op of doc) {
    switch (op.t) {
      case 'align': align = op.v; break;
      case 'text': for (const l of wrap(op.v, cols(op.s))) put(mark(l, op.s)); break;
      case 'rule': put(rule(width, op.ch || '-')); break;
      case 'row': for (const l of leftRight(op.left, op.right, cols(op.s))) put(mark(l, op.s)); break;
      case 'feed': for (let i = 0; i < (op.n ?? 1); i++) lines.push(''); break;
      case 'qr': put(`[QR: ${op.v}]`); break;
      case 'cut': lines.push('════════════ ✂ CUT ════════════'.slice(0, width)); break;
      case 'drawer': lines.push('[cash drawer kick]'); break;
    }
  }
  return lines.join('\n');
}
