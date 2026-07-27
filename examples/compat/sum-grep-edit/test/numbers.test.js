import assert from 'node:assert/strict';
import test from 'node:test';

import { countOf, double, negate, sumAll } from '../src/numbers.js';

test('double/negate/countOf helpers are correct', () => {
  assert.equal(double(4), 8);
  assert.equal(negate(3), -3);
  assert.equal(countOf([1, 2, 3]), 3);
});

test('sumAll returns the total of the list', () => {
  assert.equal(sumAll([1, 2, 3]), 6);
  assert.equal(sumAll([]), 0);
});
