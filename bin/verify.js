/**
 * Hands-on verification against the REAL printer. Each scenario tells you what to
 * do and exactly what to check on the paper. Run them one at a time:
 *
 *   node bin/verify.js cuts          # every ticket is its own cut slip
 *   node bin/verify.js waiters       # 3 waiters print at once, nothing garbled
 *   node bin/verify.js offline       # unplug/replug: nothing lost, prints when back
 *   node bin/verify.js crash-stage   # persist jobs then "crash" (no print)
 *   node bin/verify.js crash-recover # restart: the pre-crash jobs print
 *
 * (crash-stage then crash-recover proves durability across a process restart.)
 */
import { demoService, drain, ask, hr } from './_harness.js';
import { loadConfig } from '../src/config.js';
import { fileStore } from '../src/adapters/store/file.js';
import { encode } from '../src/core/render/escpos.js';
import { DocBuilder } from '../src/core/render/doc.js';

const scenario = process.argv[2];

/** A compact, unmistakable slip so you can eyeball order and cuts. */
function slip(title, lines = []) {
  const b = new DocBuilder().align('center').text(title, { bold: true, doubleH: true }).rule('=');
  b.align('left');
  for (const l of lines) b.text(l);
  b.feed(1).cut();
  return b.build();
}

async function cuts() {
  hr('CUTS');
  console.log('Printing 3 tickets. CHECK: 3 physically separate slips, each cleanly cut,');
  console.log('no ticket sharing paper with the next. (Your printer reports Cut=YES.)\n');
  const { service, printers } = await demoService();
  for (let n = 1; n <= 3; n++)
    await service.print({ id: `cut-${n}-${Date.now()}`, station: 'cashier', number: n,
      items: [{ name: `CUT TEST ${n} of 3`, qty: 1 }], footer: `— end of slip ${n} —` });
  await drain(printers);
  console.log('✓ sent 3. Verify 3 separate, cleanly-cut slips.');
}

async function waiters() {
  hr('MULTIPLE WAITERS (concurrency)');
  console.log('3 waiters fire 3 tickets each AT THE SAME TIME (9 total, one printer).');
  console.log('CHECK: 9 clean slips, none garbled/interleaved, each fully readable.');
  console.log('The queue serializes them — no two tickets should be mixed together.\n');
  const { service, printers } = await demoService();
  const stamp = Date.now();
  const jobs = [];
  for (const w of ['A', 'B', 'C'])
    for (let n = 1; n <= 3; n++)
      jobs.push(service.print({
        id: `w${w}-${n}-${stamp}`, station: 'kitchen', number: n, server: `Waiter ${w}`,
        items: [{ name: `Waiter ${w} — ticket ${n}/3`, qty: n }, { name: 'Momo', qty: 2 }],
      }));
  await Promise.all(jobs);        // submitted simultaneously
  await drain(printers);
  console.log('✓ sent 9 concurrently. Verify 9 clean, non-interleaved slips.');
}

async function offline() {
  hr('OFFLINE / RECONNECT (fault tolerance)');
  console.log('This proves a ticket is NEVER lost when the printer drops, and prints');
  console.log('automatically when it returns.\n');
  // Retry effectively forever, quick cadence, so it prints the moment you replug.
  const { service, printers } = await demoService({ policy: { maxAttempts: 100000, baseDelayMs: 500, maxDelayMs: 3000 } });
  await ask('1) UNPLUG the printer (power or ethernet). Press Enter when unplugged… ');
  console.log('\nQueuing a ticket while OFFLINE — watch it retry (it will NOT be lost):');
  await service.print({ id: `offline-${Date.now()}`, station: 'cashier',
    items: [{ name: 'OFFLINE TEST — I survived the outage', qty: 1 }], footer: 'printed after reconnect' });
  await ask('\n2) Now PLUG the printer back in. Press Enter and wait for it to print… ');
  console.log('Waiting for the ticket to drain (retries every ~3s until it succeeds)…');
  await drain(printers);
  console.log('✓ printed after reconnect. Nothing was lost. Check the slip came out.');
}

// --- crash / restart durability: two steps ---
async function crashStage() {
  hr('CRASH DURABILITY — step 1: stage + crash');
  console.log('Persisting 3 jobs to the durable queue, then exiting WITHOUT printing');
  console.log('(simulating a crash right after the jobs were accepted).\n');
  const cfg = loadConfig();
  const store = await fileStore(cfg.store.dir);
  for (let n = 1; n <= 3; n++) {
    const bytes = encode(slip(`CRASH-RECOVERY ${n}/3`, ['This was accepted BEFORE a crash', 'and must print on restart.']), { width: 48 });
    await store.add({ id: `crash-${n}`, key: `crash-${n}`, printerId: 'cashier',
      bytes: Buffer.from(bytes).toString('base64'), attempts: 0, createdAt: Date.now() + n });
  }
  console.log(`✓ 3 jobs persisted in ${cfg.store.dir}/pending, NOT printed.`);
  console.log('Now run:  node bin/verify.js crash-recover');
}

async function crashRecover() {
  hr('CRASH DURABILITY — step 2: restart + recover');
  console.log('Booting the agent. It should find the 3 persisted jobs and print them.\n');
  const { printers } = await demoService();   // buildService calls queue.recover()
  await drain(printers);
  console.log('✓ recovery complete. Verify the 3 CRASH-RECOVERY slips printed.');
}

async function cutcal() {
  const feed = Number(process.argv[3] || 7);
  hr(`CUT CALIBRATION (cutFeed=${feed})`);
  console.log('Prints 2 slips. The "★ LAST LINE ★" MUST stay on its own slip.');
  console.log('If it jumps to the TOP of the next slip, increase the number:');
  console.log('  node bin/verify.js cutcal 8   (try 8, 9, … until the last line stays put)\n');
  const { service, printers, printerId } = await demoService();
  printers.get(printerId).cutFeed = feed;      // override just for this run
  for (let n = 1; n <= 2; n++)
    await service.print({ id: `cutcal-${feed}-${n}-${Date.now()}`, station: 'cashier', number: n,
      items: [{ name: `CUTCAL feed=${feed} — slip ${n}`, qty: 1 }], footer: '★ LAST LINE — must be on THIS slip ★' });
  await drain(printers);
  console.log(`✓ sent 2 at cutFeed=${feed}. If both "★ LAST LINE ★" stayed on their own slip, set cutFeed:${feed} in printers.json.`);
}

async function cutladder() {
  const feeds = (process.argv[3] ? process.argv[3].split(',') : ['8', '12', '16', '20']).map(Number);
  hr(`CUT LADDER (feeds: ${feeds.join(', ')})`);
  console.log('Prints one slip per feed value. Each slip ends with its OWN feed number.');
  console.log('Find the SMALLEST feed whose "▼ END feed=N ▼" line stayed on its own slip');
  console.log('(did NOT jump to the top of the next slip). That N is your cutFeed.\n');
  const { service, printers, printerId } = await demoService();
  const p = printers.get(printerId);
  for (const f of feeds) {
    p.cutFeed = f;
    await service.print({ id: `ladder-${f}-${Date.now()}`, station: 'cashier', number: f,
      items: [{ name: `>>> CUT LADDER feed=${f} <<<`, qty: 1 }], footer: `▼ END feed=${f} — must be on THIS slip ▼` });
    await drain(printers);   // one slip fully out before the next
  }
  console.log(`✓ printed ${feeds.length} slips. Tell me the smallest feed whose END line stayed put.`);
}

const run = { cuts, waiters, offline, cutcal, cutladder, 'crash-stage': crashStage, 'crash-recover': crashRecover }[scenario];
if (!run) {
  console.log('Usage: node bin/verify.js <cuts|waiters|offline|crash-stage|crash-recover>');
  process.exit(1);
}
await run();
process.exit(0);
