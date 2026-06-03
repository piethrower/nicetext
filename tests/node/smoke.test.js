import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { VERSION } from '../../js/src/index.js';

test('core module loads', () => {
  assert.equal(typeof VERSION, 'string');
});
