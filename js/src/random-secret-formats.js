// Random-secret formats. The "Make a random secret" UI generates bytes
// that should look like a real ciphertext file from a popular tool, so
// an interceptor who recovers the plaintext (i.e., the steganographic
// secret) can't trivially distinguish it from the genuine output of
// that tool. Two real-looking formats plus pure random:
//
//   - 'pure'      : N random bytes, exact length.
//   - 'openssl'   : OpenSSL `enc -aes-256-cbc -salt -pbkdf2` shape.
//                   8 bytes ASCII "Salted__" + 8 random salt + N body
//                   bytes (multiple of 16). Body min 16 bytes (one AES
//                   block plus PKCS#7 padding). Wrong-password decrypt
//                   produces garbage / padding error, indistinguishable
//                   from the genuine "wrong key" outcome.
//   - 'veracrypt' : VeraCrypt file container. No magic bytes (the
//                   header is encrypted into the first 512 bytes), so
//                   the file looks like uniform random data. Min size
//                   292 KB (VeraCrypt's stated minimum for non-system
//                   file containers); sector-aligned to 512 bytes.
//
// Pure planning (size math + magic bytes) lives here so it can be
// node-tested without a DOM. The generator helper takes an explicit
// fillRandom callback so tests can substitute deterministic bytes.

export const FORMAT_PURE = 'pure';
export const FORMAT_OPENSSL = 'openssl';
export const FORMAT_VERACRYPT = 'veracrypt';

export const OPENSSL_MAGIC = new Uint8Array([0x53, 0x61, 0x6C, 0x74, 0x65, 0x64, 0x5F, 0x5F]);
export const OPENSSL_HEADER_LEN = 16; // 8 magic + 8 salt
export const OPENSSL_BLOCK = 16;      // AES block size

export const VERACRYPT_MIN_BYTES = 292 * 1024; // 299,008
export const VERACRYPT_SECTOR = 512;

export const FORMAT_LABELS = {
  [FORMAT_PURE]: 'Pure random',
  [FORMAT_OPENSSL]: 'OpenSSL enc',
  [FORMAT_VERACRYPT]: 'VeraCrypt',
};

// How many bytes the generator will actually produce for a given
// format and requested target N. For 'pure' this is exactly N. For
// 'openssl' the body is rounded to the nearest AES block (min 16). For
// 'veracrypt' the size is bumped up to the 292 KB minimum and aligned
// to a 512-byte sector.
export function plannedTotalBytes(format, requestedN) {
  if (!Number.isFinite(requestedN) || requestedN < 1) return 0;
  if (format === FORMAT_OPENSSL) {
    let body = requestedN - OPENSSL_HEADER_LEN;
    body = Math.round(body / OPENSSL_BLOCK) * OPENSSL_BLOCK;
    if (body < OPENSSL_BLOCK) body = OPENSSL_BLOCK;
    return OPENSSL_HEADER_LEN + body;
  }
  if (format === FORMAT_VERACRYPT) {
    const aligned = Math.ceil(requestedN / VERACRYPT_SECTOR) * VERACRYPT_SECTOR;
    return Math.max(VERACRYPT_MIN_BYTES, aligned);
  }
  return Math.floor(requestedN);
}

// Generate the bytes for a given format. `fillRandom(buf)` fills buf
// with cryptographically-strong random bytes. Caller passes a closure
// over crypto.getRandomValues (browser) or node:crypto.randomFillSync
// (tests). The function never touches global crypto itself, keeping it
// runtime-agnostic.
export function generateRandomSecret(format, requestedN, fillRandom) {
  const total = plannedTotalBytes(format, requestedN);
  const bytes = new Uint8Array(total);
  if (format === FORMAT_OPENSSL) {
    bytes.set(OPENSSL_MAGIC, 0);
    fillRandom(bytes.subarray(8)); // 8-byte salt + body
    return bytes;
  }
  fillRandom(bytes);
  return bytes;
}
