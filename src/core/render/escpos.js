/**
 * Doc -> ESC/POS bytes. Self-contained encoder (no external printer lib) so we
 * have full control and zero surprises. Targets EPSON-compatible ESC/POS, which
 * the POS-8360 speaks. Text is encoded per the printer's active code page.
 */
import { Buffer } from 'node:buffer';
import { rule as ruleStr, wrap, center, leftRight } from './format.js';

const ESC = 0x1b, GS = 0x1d;
const bytes = (...b) => Buffer.from(b);

// --- control sequences ---
const INIT = bytes(ESC, 0x40);                       // ESC @  — reset
const ALIGN = { left: bytes(ESC, 0x61, 0), center: bytes(ESC, 0x61, 1), right: bytes(ESC, 0x61, 2) };
const BOLD = (on) => bytes(ESC, 0x45, on ? 1 : 0);   // ESC E
const INVERT = (on) => bytes(GS, 0x42, on ? 1 : 0);  // GS B  — white/black reverse
const SIZE = (dw, dh) => bytes(GS, 0x21, (dw ? 0x10 : 0) | (dh ? 0x01 : 0)); // GS ! width|height
const FEED = (n) => bytes(ESC, 0x64, Math.max(0, Math.min(255, n))); // ESC d n
// GS V 66 n — cut "function B": the printer feeds the paper to its OWN cutting
// position (it knows the head-to-blade gap) and THEN cuts, so the last printed
// line ALWAYS clears the blade. `margin` (dots) adds bottom whitespace.
// Replaces the old "ESC d cutFeed + GS V 0": GS V 0 cuts at the *current* head
// position, and the manual feed we used to bridge the ~2cm blade gap was ≈ that
// gap — borderline, so the receipt's tail intermittently landed on the NEXT slip.
// (Use 0x41 instead of 0x42 for a full cut if partial-cut tabs are a problem.)
const CUT = (margin = 0) => bytes(GS, 0x56, 0x42, Math.max(0, Math.min(255, margin)));
const DRAWER = bytes(ESC, 0x70, 0x00, 0x19, 0xfa);   // ESC p 0 — kick pin 2

/** QR: GS ( k sequence, model 2. size 1..16, ecc 0..3 (L,M,Q,H). */
function qr(data, { size = 6, ecc = 1 } = {}) {
  const store = Buffer.from(data, 'utf8');
  const len = store.length + 3;
  const pL = len & 0xff, pH = (len >> 8) & 0xff;
  return Buffer.concat([
    bytes(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00), // model 2
    bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, size),        // module size
    bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x30 + ecc),  // error correction
    bytes(GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30),            // store data (header)
    store,
    bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30),        // print
  ]);
}

/**
 * @param {import('./doc.js').Doc} doc
 * @param {{width?:number, encoding?:string, cut?:boolean, cutFeed?:number}} [opts]
 *   cutFeed: EXTRA bottom margin (in dots) added after the blade cut. The printer
 *   now feeds the head-to-blade gap itself (GS V 66, function B), so this is just
 *   cosmetic whitespace — it no longer has to bridge the gap. 0 is safe; ~24–48
 *   gives a few mm of clearance below the last line.
 * @returns {Buffer}
 */
export function encode(doc, { width = 48, encoding = 'latin1', cut = true, cutFeed = 7 } = {}) {
  const parts = [INIT];
  const enc = (s) => Buffer.from(s, encoding);      // per active code page
  const line = (s) => parts.push(enc(s), bytes(0x0a));
  const withStyle = (s, body) => {
    if (s?.bold) parts.push(BOLD(true));
    if (s?.invert) parts.push(INVERT(true));
    if (s?.doubleW || s?.doubleH) parts.push(SIZE(!!s.doubleW, !!s.doubleH));
    body();
    if (s?.doubleW || s?.doubleH) parts.push(SIZE(false, false));
    if (s?.invert) parts.push(INVERT(false));
    if (s?.bold) parts.push(BOLD(false));
  };
  // Double-width halves the usable columns for that op.
  const colsFor = (s) => (s?.doubleW ? Math.floor(width / 2) : width);

  for (const op of doc) {
    switch (op.t) {
      case 'align': parts.push(ALIGN[op.v] ?? ALIGN.left); break;
      case 'text': withStyle(op.s, () => { for (const l of wrap(op.v, colsFor(op.s))) line(l); }); break;
      case 'rule': line(ruleStr(width, op.ch || '-')); break;
      case 'row': withStyle(op.s, () => { for (const l of leftRight(op.left, op.right, colsFor(op.s))) line(l); }); break;
      case 'feed': parts.push(FEED(op.n ?? 1)); break;
      case 'qr': parts.push(ALIGN.center, qr(op.v), ALIGN.left); break;
      case 'cut': if (cut) parts.push(CUT(cutFeed)); break;
      case 'drawer': parts.push(DRAWER); break;
    }
  }
  return Buffer.concat(parts);
}

export const _internal = { qr, center }; // exposed for tests
