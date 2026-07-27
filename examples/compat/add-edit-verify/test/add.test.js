import assert from 'node:assert/strict';
import test from 'node:test';

import { add } from '../src/add.js';

test('add returns the sum of two numbers', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(10, 4), 14);
});
