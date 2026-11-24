import { compare, ONE, parseExact, ZERO } from './rational.js';

export class PrismRefusal extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrismRefusal';
    this.code = code;
  }
}

export function refuse(code, message) {
  throw new PrismRefusal(code, message);
}

export function refusalResult(error) {
  if (!(error instanceof PrismRefusal)) throw error;
  return { status: 'REFUSED', code: error.code, message: error.message };
}

export function exact(value, label) {
  try {
    return parseExact(value);
  } catch {
    refuse('INVALID_EXACT_VALUE', `${label} must be an integer, decimal string or fraction`);
  }
}

export function interval(value, label, { lower = ZERO, upper = ONE, strictLower = false } = {}) {
  if (value && !Array.isArray(value) && Object.hasOwn(value, 'lo') && Object.hasOwn(value, 'hi')) {
    value = [value.lo, value.hi];
  }
  const bounds = Array.isArray(value) ? value : [value, value];
  if (bounds.length !== 2) refuse('INVALID_INTERVAL', `${label} must have two endpoints`);
  const [lo, hi] = bounds.map((entry) => exact(entry, label));
  if (compare(lo, hi) > 0 || (upper !== null && compare(hi, upper) > 0)
      || compare(lo, lower) < (strictLower ? 1 : 0)) {
    refuse('INVALID_INTERVAL', `${label} is outside its bounds or reversed`);
  }
  return [lo, hi];
}

export function idOf(value, label) {
  const id = typeof value === 'string' ? value : value?.id;
  if (typeof id !== 'string' || id.length === 0 || id.trim() !== id) {
    refuse('INVALID_INPUT', `${label} must have a nonempty ID`);
  }
  return id;
}

export function list(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) {
    refuse('INVALID_INPUT', `${label} must be an array with at least ${minimum} entries`);
  }
  return value;
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function records(value, label, minimum = 0) {
  const entries = list(value, label, minimum);
  if (entries.some((entry) => !isRecord(entry))) refuse('INVALID_INPUT', `${label} must contain objects`);
  return entries;
}

export function uniqueIds(values, label, minimum = 0) {
  const ids = list(values, label, minimum).map((entry) => idOf(entry, label));
  if (new Set(ids).size !== ids.length) refuse('INVALID_INPUT', `${label} has duplicate IDs`);
  return ids;
}

export function own(record, id) {
  return record != null && Object.hasOwn(record, id) ? record[id] : undefined;
}
