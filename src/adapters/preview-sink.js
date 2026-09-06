/**
 * PREVIEW sink — render each slip to the terminal (and a file), no printer.
 *
 * Wired into PrintService in preview mode (SNACKK_PREVIEW=1). It receives the
 * render DOC — the same structure the ESC/POS encoder consumes — and turns it
 * into the human-readable text `toText` produces for bin/preview.js, so what you
 * see here is exactly what the paper would say. The rest of the pipeline (SSE,
 * routing, idempotency, the durable queue) runs for real, so this verifies the
 * whole chain end-to-end with no hardware. Deletable: it's only referenced from
 * bootstrap's preview branch.
 */

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { toText } from '../core/render/preview.js';

/**
 * @param {{dir?:string|null, write?:(s:string)=>void}} [o]
 *   dir   — where to append a running log of slips (null = terminal only).
 *   write — sink for the terminal block (default console.log); injectable for tests.
 * @returns {(o:{doc:any, ticket:any, width?:number})=>void}
 */
export function previewSink({ dir = null, write = (s) => console.log(s) } = {}) {
  const file = dir ? path.join(dir, 'preview-slips.txt') : null;
  return ({ doc, ticket, width = 48 }) => {
    const text = toText(doc, { width });
    const bar = '─'.repeat(width);
    const head = `${ticket.station}#${ticket.number ?? ''}${ticket.voided ? ' · VOID' : ''}`;
    const block = `\n┌${bar}┐  ${head}  ${new Date().toISOString()}\n${text}\n└${bar}┘\n`;
    write(block);
    if (file) {
      try { appendFileSync(file, block); } catch { /* preview is best-effort */ }
    }
  };
}
