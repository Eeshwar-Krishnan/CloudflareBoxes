import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTANCE_SIZES, DEFAULT_INSTANCE_SIZE, LEGACY_INSTANCE_SIZE, isInstanceSize } from '../src/sizes.ts';

test('instance sizes validate inputs and preserve the previous default for existing boxes', () => {
  assert.equal(DEFAULT_INSTANCE_SIZE, 'standard-2');
  assert.equal(LEGACY_INSTANCE_SIZE, 'lite');
  for (const size of INSTANCE_SIZES) assert.equal(isInstanceSize(size), true);
  for (const value of ['standard-5', '', null, 1, {}, 'STANDARD-2']) assert.equal(isInstanceSize(value), false);
});
