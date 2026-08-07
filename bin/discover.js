/**
 * Discover printers on the LAN and print their IP + MAC, so you can drop the MACs
 * into printers.json. Optionally fire an identify slip at each so you can see
 * which physical printer is which.
 *   node bin/discover.js
 *   node bin/discover.js --identify
 */
import { discoverPrinters } from '../src/adapters/discovery/scan.js';
import { encode } from '../src/core/render/escpos.js';
import { DocBuilder } from '../src/core/render/doc.js';
import { tcpTransport } from '../src/adapters/transport/tcp.js';

const identify = process.argv.includes('--identify');

console.log('Scanning the LAN for printers on port 9100…');
const found = await discoverPrinters({});
if (!found.length) { console.log('No printers found. Check power/cable and that you are on the same subnet.'); process.exit(0); }

console.log(`\nFound ${found.length} printer(s):`);
for (const { ip, mac } of found) console.log(`  ${ip.padEnd(15)}  mac=${mac ?? '(unknown)'}`);

if (identify) {
  console.log('\nSending an identify slip to each…');
  for (const { ip, mac } of found) {
    const doc = new DocBuilder()
      .align('center').text('PRINTER IDENTIFY', { bold: true, doubleH: true })
      .rule('=').text(`IP:  ${ip}`).text(`MAC: ${mac ?? '?'}`)
      .text('Put this MAC in printers.json').feed(1).cut().build();
    try { await tcpTransport({ host: ip }).send(encode(doc)); console.log(`  ✓ ${ip}`); }
    catch (e) { console.log(`  ✗ ${ip}: ${e.message}`); }
  }
}
console.log('\nTip: map a station to a MAC in printers.json, e.g.');
console.log('  { "printers": { "kitchen": { "station": "kitchen", "mac": "aa:bb:cc:dd:ee:ff", "width": 48 } } }');
