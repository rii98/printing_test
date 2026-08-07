/**
 * Send a real ticket to a real printer through the full service (validate ->
 * route -> render -> queue -> TCP).
 *   node bin/print.js kot|bot|bill|void     # a sample
 *   node bin/print.js file ./ticket.json     # your own ticket
 *
 * For piloting on ONE printer: any station with no configured printer falls back
 * to the single available printer, so you can see KOT/BOT/BILL/VOID all come out.
 */
import { loadConfig } from '../src/config.js';
import { buildService } from '../src/bootstrap.js';
import { samples } from './_samples.js';
import fs from 'node:fs';

const [mode, arg] = process.argv.slice(2);
const ticket = mode === 'file' ? JSON.parse(fs.readFileSync(arg, 'utf8')) : samples[mode || 'bill'];
if (!ticket) { console.error(`unknown sample "${mode}". Use: kot | bot | bill | void | file <path>`); process.exit(1); }

const cfg = loadConfig();
const { service, printers } = await buildService(cfg);

// Pilot fallback: route unserved stations to the first available printer.
const firstPrinter = [...printers.keys()][0];
if (firstPrinter) for (const st of ['kitchen', 'bar', 'cashier'])
  if (!service.stationToPrinter[st]) service.stationToPrinter[st] = firstPrinter;

const result = await service.print(ticket);
console.log('result:', result);
await Promise.all([...printers.values()].map((p) => p.queue.onIdle()));
console.log(result.status === 'queued' ? '✓ printed (check the receipt)' : `no print: ${result.status}`);
process.exit(0);
