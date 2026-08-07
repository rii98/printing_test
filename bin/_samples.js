/** Sample tickets used by preview + live-print CLIs. */
export const samples = {
  kot: {
    id: 'demo-kot', number: 12, station: 'kitchen', orderType: 'dine-in', table: '5', server: 'Ram',
    placedAt: '2026-08-07T12:30:00',
    items: [
      { name: 'Chicken Momo (Steam)', qty: 2, modifiers: ['No garlic', 'Extra spicy'], note: 'allergy: peanuts' },
      { name: 'Veg Chowmein', qty: 1 },
      { name: 'Chicken Sekuwa Platter', qty: 1 },
    ],
  },
  bot: {
    id: 'demo-bot', number: 12, station: 'bar', orderType: 'dine-in', table: '5',
    items: [{ name: 'Mojito', qty: 2 }, { name: 'Everest Beer', qty: 3 }],
  },
  bill: {
    id: 'demo-bill', number: 12, station: 'cashier', table: '5', currency: 'Rs', placedAt: '2026-08-07T13:05:00',
    items: [
      { name: 'Chicken Momo (Steam)', qty: 2, price: 180 },
      { name: 'Veg Chowmein', qty: 1, price: 160 },
      { name: 'Mojito', qty: 2, price: 250 },
      { name: 'Everest Beer', qty: 3, price: 350 },
    ],
    discount: 100, serviceCharge: 130, taxRate: 0.13, taxLabel: 'VAT 13%',
    payment: 'Cash', qr: 'https://snackk.example/bill/demo-bill', footer: 'Dhanyabaad! Please visit again',
  },
  void: {
    id: 'demo-kot', revision: 1, station: 'kitchen', voided: true, voidReason: 'Guest left', number: 12, table: '5',
    items: [{ name: 'Chicken Momo (Steam)', qty: 2 }],
  },
};
