/**
 * HBAR and tinybar conversion.
 *
 * Everything a human reads in this demo is denominated in HBAR. Tinybars appear
 * in exactly one place: the x402 wire format, which requires integer atomic units
 * (`@x402/hedera`: "HBAR (asset: 0.0.0): amount is in tinybars"). Conversion
 * happens at that boundary and nowhere else.
 *
 * Every operation here is integer or string work. Hedera balances run past 2^53,
 * where a double stops representing every integer, so a single float in this file
 * would silently corrupt values that the whole demo then attests to.
 */

/** 1 HBAR = 10^8 tinybars. */
export const TINYBARS_PER_HBAR = 100_000_000n;

/** Tinybars have eight decimal places of HBAR precision, and no more. */
export const HBAR_DECIMALS = 8;

/**
 * Converts tinybars to an exact HBAR decimal string.
 *
 * Returns a string rather than a number on purpose: the result routinely exceeds
 * what a double can represent, and it ends up inside a signed attestation.
 *
 * @param tinybars - Whole tinybars, as a bigint or an integer string
 * @returns Exact HBAR amount, trailing zeros trimmed
 */
export function toHbar(tinybars: bigint | string): string {
  const raw = typeof tinybars === "bigint" ? tinybars : parseWholeTinybars(tinybars);
  if (raw < 0n) throw new Error(`Negative tinybar amount: ${tinybars}`);

  const whole = raw / TINYBARS_PER_HBAR;
  const fraction = (raw % TINYBARS_PER_HBAR).toString().padStart(HBAR_DECIMALS, "0");
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed === "" ? whole.toString() : `${whole}.${trimmed}`;
}

/**
 * Converts an HBAR decimal string to whole tinybars.
 *
 * @param hbar - HBAR amount, at most eight decimal places
 * @returns Whole tinybars
 */
export function toTinybars(hbar: string | bigint): bigint {
  if (typeof hbar === "bigint") return hbar * TINYBARS_PER_HBAR;

  const text = String(hbar).trim().replace(/^\+/, "");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`Not a valid HBAR amount: ${JSON.stringify(hbar)}`);

  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > HBAR_DECIMALS) {
    throw new Error(
      `${text} HBAR has more precision than a tinybar can hold; the limit is ${HBAR_DECIMALS} decimal places.`,
    );
  }
  return BigInt(whole) * TINYBARS_PER_HBAR + BigInt(fraction.padEnd(HBAR_DECIMALS, "0") || "0");
}

/**
 * Formats an HBAR amount for reading, with thousands separators.
 *
 * Display only. Never feed the result back into a conversion.
 *
 * @param hbar - Exact HBAR amount as produced by `toHbar`
 * @returns Grouped string, e.g. "34,033,354,182.96113178"
 */
export function formatHbar(hbar: string): string {
  const [whole, fraction] = hbar.split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

function parseWholeTinybars(value: string): bigint {
  const text = value.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`Not a whole tinybar amount: ${JSON.stringify(value)}`);
  }
  return BigInt(text);
}
