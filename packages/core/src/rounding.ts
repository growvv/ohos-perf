/**
 * Python's `round(value, 2)` for a non-negative double.
 *
 * Python rounds the **exact decimal value of the double** to two places,
 * breaking exact ties toward the even digit. `Math.round(value * 100) / 100`
 * is half-up and also rounds the already-rounded product, so it disagrees at
 * `0.125` (→ `0.13`) and agrees only by luck elsewhere.
 *
 * The decomposition below is exact: a finite double is `mantissa × 2^exponent`
 * with an integer mantissa, so the scaled value is a rational whose rounding
 * can be decided with integers alone.
 *
 * Lives here rather than beside the component-reuse analyzer that first
 * needed it: the thermal parser rounds device readings to the same precision
 * HapRay reports, and a parser should not import an analyzer.
 */
export function round2HalfEven(value: number): number {
  if (!Number.isFinite(value)) return value;
  const negative = value < 0;
  const { mantissa, exponent } = decompose(Math.abs(value));

  const scaled = mantissa * 100n;
  let rounded: bigint;
  if (exponent >= 0) {
    rounded = scaled << BigInt(exponent);
  } else {
    const denominator = 1n << BigInt(-exponent);
    const quotient = scaled / denominator;
    const remainder = scaled % denominator;
    const doubled = remainder * 2n;
    if (doubled > denominator) rounded = quotient + 1n;
    else if (doubled < denominator) rounded = quotient;
    // Exact tie: pick the even neighbour, as Python does.
    else rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
  }

  const result = Number(rounded) / 100;
  return negative ? -result : result;
}

/** `|value|` as `mantissa × 2^exponent`, exactly, for a finite non-zero double. */
function decompose(value: number): { mantissa: bigint; exponent: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const exponentBits = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  if (exponentBits === 0) return { mantissa, exponent: -1074 };
  mantissa |= 1n << 52n;
  return { mantissa, exponent: exponentBits - 1075 };
}
