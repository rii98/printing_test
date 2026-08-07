/**
 * Preview receipts in the terminal — NO printer required.
 *   node bin/preview.js            # all sample tickets at 80mm
 *   node bin/preview.js --width 32 # see them at 58mm
 *   cat ticket.json | node bin/preview.js -   # preview your own ticket from stdin
 */
import { normalizeTicket } from '../src/core/domain.js';
import { renderTicket } from '../src/core/render/index.js';
import { toText } from '../src/core/render/preview.js';
import { samples } from './_samples.js';

const args = process.argv.slice(2);
const width = Number(args[args.indexOf('--width') + 1]) || 48;
const branding = { shopName: 'NAMASTE MINI MARKET', shopLines: ['Kathmandu • 01-5555555'] };

function show(title, ticket) {
  const t = normalizeTicket(ticket);
  const bar = '─'.repeat(width);
  console.log(`\n┌${bar}┐  ${title}`);
  console.log(toText(renderTicket(t, { branding }), { width }));
  console.log(`└${bar}┘`);
}

if (args.includes('-')) {
  const raw = await new Promise((r) => { let d = ''; process.stdin.on('data', (c) => (d += c)); process.stdin.on('end', () => r(d)); });
  show('stdin', JSON.parse(raw));
} else {
  show('KOT — kitchen', samples.kot);
  show('BOT — bar', samples.bot);
  show('BILL — cashier', samples.bill);
  show('VOID slip', samples.void);
}
