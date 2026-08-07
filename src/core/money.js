/**
 * Money as integer minor units (paisa / cents).
 *
 * Floating point can't represent 0.10 exactly, so summing prices as floats makes
 * a printed line item disagree with the subtotal by a paisa — the receipt visibly
 * doesn't add up, which fails a tax/audit check. The fix that lasts: do every
 * operation on integers. Round each line to the minor unit ONCE, then add
 * integers. The arithmetic on paper then reconciles exactly, by construction.
 *
 * Scale is fixed at 2 decimals (minor unit = 1/100), matching every currency this
 * serves (Rs, $). It's a single constant if a 0- or 3-decimal currency ever needs
 * support — the rest of the module is written in terms of it.
 */
const SCALE = 2;
const FACTOR = 10 ** SCALE; // 100

/**
 * Major units (e.g. 3.50) -> integer minor units (350), rounded half away from
 * zero at the minor unit. The tiny nudge undoes binary error that leaves values
 * like 1.005 * 100 = 100.4999999999 sitting just below .5; at receipt magnitudes
 * it never crosses a real boundary.
 * @param {number} major
 * @returns {number} integer minor units
 */
export function toMinor(major) {
  const n = Number(major);
  if (!Number.isFinite(n)) return 0;
  const scaled = n * FACTOR;
  return Math.round(scaled + Math.sign(scaled) * 1e-6);
}

/** Integer minor units (350) -> major-unit number (3.5). */
export const fromMinor = (minor) => minor / FACTOR;

/**
 * Apply a ratio (e.g. a tax rate 0.13) to an integer minor amount, returning
 * integer minor units. Kept here so tax rounding lives with the rest of the
 * money math rather than being reinvented in a layout.
 * @param {number} minor  integer minor units
 * @param {number} rate   ratio (not money)
 * @returns {number} integer minor units
 */
export const applyRate = (minor, rate) => Math.round(minor * (Number.isFinite(rate) ? rate : 0));
