// Node smoke for js/src/random-secret-formats.js. Verifies size math,
// magic bytes, and that the generator wires the fillRandom callback in
// the correct ranges (i.e., never overwrites the OpenSSL magic prefix).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';

import {
  FORMAT_PURE, FORMAT_OPENSSL, FORMAT_VERACRYPT,
  OPENSSL_MAGIC, OPENSSL_HEADER_LEN, OPENSSL_BLOCK,
  VERACRYPT_MIN_BYTES, VERACRYPT_SECTOR,
  plannedTotalBytes, generateRandomSecret,
} from '../../../js/src/random-secret-formats.js';

const fill = (buf) => randomFillSync(buf);

test('plannedTotalBytes: pure is exact', () => {
  assert.equal(plannedTotalBytes(FORMAT_PURE, 1), 1);
  assert.equal(plannedTotalBytes(FORMAT_PURE, 128), 128);
  assert.equal(plannedTotalBytes(FORMAT_PURE, 1048576), 1048576);
});

test('plannedTotalBytes: openssl rounds body to nearest 16, min 16', () => {
  // 128 → body target 112, already mult of 16, total 128
  assert.equal(plannedTotalBytes(FORMAT_OPENSSL, 128), 128);
  // 90 → body target 74, round nearest = 80, total 96
  assert.equal(plannedTotalBytes(FORMAT_OPENSSL, 90), 96);
  // 8 → body target -8, clamp to 16, total 32
  assert.equal(plannedTotalBytes(FORMAT_OPENSSL, 8), 32);
  // 16 → body target 0, clamp to 16, total 32
  assert.equal(plannedTotalBytes(FORMAT_OPENSSL, 16), 32);
  // 1 → clamp to 32
  assert.equal(plannedTotalBytes(FORMAT_OPENSSL, 1), 32);
  // 100 → body target 84, round = 80 (nearest), total 96
  assert.equal(plannedTotalBytes(FORMAT_OPENSSL, 100), 96);
  // 104 → body target 88, round nearest = 96 (88 is exactly between
  // 80 and 96; Math.round rounds half-up, so 88/16=5.5 → 6 → 96)
  assert.equal(plannedTotalBytes(FORMAT_OPENSSL, 104), 112);
});

test('plannedTotalBytes: veracrypt bumps to ≥292 KB, sector-aligned', () => {
  assert.equal(plannedTotalBytes(FORMAT_VERACRYPT, 1), VERACRYPT_MIN_BYTES);
  assert.equal(plannedTotalBytes(FORMAT_VERACRYPT, 128), VERACRYPT_MIN_BYTES);
  assert.equal(plannedTotalBytes(FORMAT_VERACRYPT, VERACRYPT_MIN_BYTES), VERACRYPT_MIN_BYTES);
  // request 292 KB + 1 byte → bump to next sector (292 KB + 512)
  assert.equal(plannedTotalBytes(FORMAT_VERACRYPT, VERACRYPT_MIN_BYTES + 1),
               VERACRYPT_MIN_BYTES + VERACRYPT_SECTOR);
  // request 500000 → already > min, but not sector-aligned;
  // 500000 / 512 = 976.5625 → ceil = 977 → 977*512 = 500224
  assert.equal(plannedTotalBytes(FORMAT_VERACRYPT, 500000), 500224);
});

test('plannedTotalBytes: invalid input → 0', () => {
  assert.equal(plannedTotalBytes(FORMAT_PURE, 0), 0);
  assert.equal(plannedTotalBytes(FORMAT_PURE, -5), 0);
  assert.equal(plannedTotalBytes(FORMAT_PURE, NaN), 0);
});

test('generateRandomSecret: pure has expected length and is fully filled', () => {
  const out = generateRandomSecret(FORMAT_PURE, 128, fill);
  assert.equal(out.length, 128);
  // Should not be all-zero (probability of all-zero from CSPRNG is negligible)
  assert.notEqual(out.reduce((a, b) => a + b, 0), 0);
});

test('generateRandomSecret: openssl starts with Salted__ magic', () => {
  const out = generateRandomSecret(FORMAT_OPENSSL, 128, fill);
  assert.equal(out.length, 128);
  for (let i = 0; i < OPENSSL_MAGIC.length; i++) {
    assert.equal(out[i], OPENSSL_MAGIC[i], `magic byte ${i} mismatch`);
  }
  // Salt (bytes 8..15) and body (16..) should be filled (non-zero on average)
  const salt = out.subarray(8, 16);
  const body = out.subarray(16);
  assert.equal(salt.length, 8);
  assert.equal(body.length, 112);
  // Body length must be multiple of 16
  assert.equal(body.length % OPENSSL_BLOCK, 0);
});

test('generateRandomSecret: openssl with deterministic fill leaves magic intact', () => {
  // Deterministic fill: write 0xAA into every byte. Magic must still be Salted__.
  const detFill = (buf) => buf.fill(0xAA);
  const out = generateRandomSecret(FORMAT_OPENSSL, 128, detFill);
  for (let i = 0; i < OPENSSL_MAGIC.length; i++) {
    assert.equal(out[i], OPENSSL_MAGIC[i]);
  }
  // Salt + body region should all be 0xAA
  for (let i = 8; i < out.length; i++) {
    assert.equal(out[i], 0xAA, `byte ${i} not filled`);
  }
});

test('generateRandomSecret: veracrypt is min size when requested small', () => {
  const out = generateRandomSecret(FORMAT_VERACRYPT, 128, fill);
  assert.equal(out.length, VERACRYPT_MIN_BYTES);
});
