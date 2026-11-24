function integer(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) return BigInt(value);
  throw new TypeError('Expected an exact integer');
}

function gcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export const ZERO = Object.freeze({ n: 0n, d: 1n });
export const ONE = Object.freeze({ n: 1n, d: 1n });

export function rational(n, d = 1n) {
  n = integer(n);
  d = integer(d);
  if (d === 0n) throw new RangeError('Rational denominator is zero');
  if (n === 0n) return ZERO;
  const divisor = d < 0n ? -gcd(n, d) : gcd(n, d);
  n /= divisor;
  d /= divisor;
  return n === 1n && d === 1n ? ONE : Object.freeze({ n, d });
}

export function parseExact(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'n') && Object.hasOwn(value, 'd')) {
    return rational(value.n, value.d);
  }
  if (typeof value === 'string') {
    const fraction = /^([+-]?\d+)\/([+-]?\d+)$/.exec(value);
    if (fraction) return rational(fraction[1], fraction[2]);
    const decimal = /^([+-]?)(\d*)\.(\d+)$/.exec(value);
    if (decimal) {
      const [, sign, whole, tail] = decimal;
      return rational(sign + whole + tail, 10n ** BigInt(tail.length));
    }
  }
  return rational(value);
}

export function add(a, b) {
  if (a.n === 0n) return b;
  if (b.n === 0n) return a;
  const common = gcd(a.d, b.d);
  return rational(a.n * (b.d / common) + b.n * (a.d / common), a.d * (b.d / common));
}

export function neg(a) { return rational(-a.n, a.d); }
export function subtract(a, b) { return add(a, neg(b)); }

export function multiply(a, b) {
  if (a.n === 0n || b.n === 0n) return ZERO;
  const left = gcd(a.n, b.d);
  const right = gcd(b.n, a.d);
  return rational((a.n / left) * (b.n / right), (a.d / right) * (b.d / left));
}

export function divide(a, b) { return multiply(a, rational(b.d, b.n)); }
export function abs(a) { return a.n < 0n ? neg(a) : a; }

export function compare(a, b) {
  const difference = a.n * b.d - b.n * a.d;
  if (difference < 0n) return -1;
  return difference > 0n ? 1 : 0;
}

export function eq(a, b) { return compare(a, b) === 0; }
export function min(a, b) { return compare(a, b) <= 0 ? a : b; }
export function max(a, b) { return compare(a, b) >= 0 ? a : b; }
export function sum(values) { return values.reduce(add, ZERO); }

export function fractionText(value) {
  const { n, d } = parseExact(value);
  return `${n}/${d}`;
}

export function decimalPreview(value, places = 8) {
  if (!Number.isSafeInteger(places) || places < 0 || places > 1000) {
    throw new RangeError('Decimal preview precision must be an integer from 0 to 1000');
  }
  const { n, d } = parseExact(value);
  const scale = 10n ** BigInt(places);
  const digits = ((n < 0n ? -n : n) * scale / d).toString().padStart(places + 1, '0');
  const magnitude = places === 0 ? digits : digits.slice(0, -places) + '.' + digits.slice(-places);
  return n < 0n ? '-' + magnitude : magnitude;
}
