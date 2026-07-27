// Trivial compat fixture: small number helpers. test/numbers.test.js is the
// source of truth for their behavior.
export const double = (n) => n * 2;

export const negate = (n) => -n;

export const sumAll = (ns) => ns.reduce((total, n) => total, 0);

export const countOf = (ns) => ns.length;
