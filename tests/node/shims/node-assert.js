// Browser shim for `node:assert` and `node:assert/strict`. Covers the
// API surface used by tests/node/*.test.js: deepEqual, equal,
// strictEqual, ok, throws, doesNotReject. Strict mode is the only
// mode (matching node:assert/strict semantics).

class AssertionError extends Error {
  constructor({ actual, expected, message, operator }) {
    super(message || `${operator} failed`);
    this.name = 'AssertionError';
    this.actual = actual;
    this.expected = expected;
    this.operator = operator;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
         !(v instanceof Uint8Array) && !(v instanceof Map) && !(v instanceof Set);
}

function deepEq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (!deepEq(v, b.get(k))) return false;
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEq(a[k], b[k])) return false;
    return true;
  }
  return false;
}

export function deepEqual(actual, expected, message) {
  if (!deepEq(actual, expected)) {
    throw new AssertionError({ actual, expected, message, operator: 'deepEqual' });
  }
}

export function notDeepEqual(actual, expected, message) {
  if (deepEq(actual, expected)) {
    throw new AssertionError({ actual, expected, message, operator: 'notDeepEqual' });
  }
}

// node:assert/strict aliases deepEqual / notDeepEqual to their
// "strict" variants, same semantics in our shim since `deepEq` is
// already strict (Object.is at leaves; no coercion).
export const deepStrictEqual = deepEqual;
export const notDeepStrictEqual = notDeepEqual;

export function equal(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new AssertionError({ actual, expected, message, operator: 'equal' });
  }
}

export const strictEqual = equal;

export function notEqual(actual, expected, message) {
  if (Object.is(actual, expected)) {
    throw new AssertionError({ actual, expected, message, operator: 'notEqual' });
  }
}

export const notStrictEqual = notEqual;

export function ok(value, message) {
  if (!value) {
    throw new AssertionError({ actual: value, expected: true, message, operator: 'ok' });
  }
}

function matchesError(err, expected) {
  if (!expected) return true;
  if (typeof expected === 'function') {
    // Could be a constructor (instanceof match) or a validator
    // function (called with err, returns truthy on match). Arrow
    // functions have no `prototype` and can't be used with
    // `instanceof`; constructors do. Use that to disambiguate.
    if (expected.prototype === undefined) {
      return !!expected(err);
    }
    return err instanceof expected;
  }
  if (expected instanceof RegExp) {
    return expected.test(err && err.message ? err.message : String(err));
  }
  if (typeof expected === 'object' && expected !== null) {
    return Object.entries(expected).every(([k, v]) =>
      v instanceof RegExp ? v.test(err[k]) : err[k] === v);
  }
  return false;
}

export function throws(fn, expected, message) {
  let threw = false;
  let err;
  try { fn(); } catch (e) { threw = true; err = e; }
  if (!threw) {
    throw new AssertionError({ message: message || 'expected fn to throw', operator: 'throws' });
  }
  if (!matchesError(err, expected)) {
    throw new AssertionError({ actual: err, expected, message: message || `error did not match: ${err && err.message}`, operator: 'throws' });
  }
}

export async function doesNotReject(promiseOrFn, message) {
  const p = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
  try {
    await p;
  } catch (e) {
    throw new AssertionError({
      actual: e,
      message: message || `unexpected rejection: ${e && e.message ? e.message : String(e)}`,
      operator: 'doesNotReject',
    });
  }
}

export async function rejects(promiseOrFn, expected, message) {
  const p = typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn;
  let rejected = false;
  let err;
  try { await p; } catch (e) { rejected = true; err = e; }
  if (!rejected) {
    throw new AssertionError({ message: message || 'expected promise to reject', operator: 'rejects' });
  }
  if (!matchesError(err, expected)) {
    throw new AssertionError({ actual: err, expected, message: message || `rejection did not match: ${err && err.message}`, operator: 'rejects' });
  }
}

export function doesNotThrow(fn, message) {
  try { fn(); }
  catch (e) {
    throw new AssertionError({
      actual: e,
      message: message || `unexpected throw: ${e && e.message ? e.message : String(e)}`,
      operator: 'doesNotThrow',
    });
  }
}

export function match(actual, regex, message) {
  if (typeof actual !== 'string' || !(regex instanceof RegExp)) {
    throw new AssertionError({
      actual, expected: regex, operator: 'match',
      message: message || 'match: actual must be string and regex must be RegExp',
    });
  }
  if (!regex.test(actual)) {
    throw new AssertionError({
      actual, expected: regex, operator: 'match',
      message: message || `expected ${JSON.stringify(actual)} to match ${regex}`,
    });
  }
}

export function doesNotMatch(actual, regex, message) {
  if (typeof actual !== 'string' || !(regex instanceof RegExp)) {
    throw new AssertionError({
      actual, expected: regex, operator: 'doesNotMatch',
      message: message || 'doesNotMatch: actual must be string and regex must be RegExp',
    });
  }
  if (regex.test(actual)) {
    throw new AssertionError({
      actual, expected: regex, operator: 'doesNotMatch',
      message: message || `expected ${JSON.stringify(actual)} not to match ${regex}`,
    });
  }
}

const assert = Object.assign(
  function assertOk(value, message) { ok(value, message); },
  { deepEqual, notDeepEqual, deepStrictEqual, notDeepStrictEqual, equal, strictEqual, notEqual, notStrictEqual, ok, throws, doesNotReject, doesNotThrow, rejects, match, doesNotMatch, AssertionError }
);
assert.strict = assert;

export default assert;
export { AssertionError };
