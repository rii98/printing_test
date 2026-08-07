// Printer registry — add/change printers here, never in the printing code.
// Each device on the LAN talks to THIS server; the server talks to the printers.
import { types as PrinterTypes, characterSet } from 'node-thermal-printer';

export const PRINTERS = {
  // Your POS-8360 / 80-V, now static on the Wi-Fi subnet.
  counter: {
    type: PrinterTypes.EPSON,               // POS-8360 reports "EPSON(ESC/POS)"
    interface: 'tcp://192.168.18.240:9100',
    width: 48,                              // 80mm, Font A = 48 chars (576 dots/line)
    characterSet: characterSet.PC437_USA,
    removeSpecialCharacters: false,
    options: { timeout: 5000 },             // fail fast if the printer is unplugged
  },

  // Add more later — one entry each, no new code:
  // kitchen: { type: PrinterTypes.EPSON, interface: 'tcp://192.168.18.241:9100', width: 48,
  //            characterSet: characterSet.PC437_USA, removeSpecialCharacters: false, options: { timeout: 5000 } },
};

export const DEFAULT_PRINTER = 'counter';

// HTTP server settings
export const SERVER_PORT = 4000;
export const SHOP_NAME = 'NAMASTE MINI MARKET';
