// FNV-1a 32-bit streaming fingerprint. Used by encode()'s validate
// option to detect round-trip divergence between source bytes and
// decoded bytes.
//
// NOT a cryptographic hash. This is our-own-bug detection on a
// self-trusted channel (encoder + decoder both run on the user's
// machine before any cover is released), not an adversarial
// integrity check. There is no attacker to craft collisions: anyone
// in a position to manipulate the comparison is already past the
// trust boundary. SHA-256 buys nothing here.
//
// 32-bit is plenty for the "two byte streams of identical length
// should be identical" predicate, a real codec divergence flips
// many bytes, not one, so collision probability for accidental
// divergence is far below 2^-32.
//
// Browser-safe ESM. No deps.

const FNV_OFFSET = 0x811c9dc5 | 0;
const FNV_PRIME = 0x01000193;

export class Fingerprint {
  constructor() {
    this.h = FNV_OFFSET;
  }
  update(bytes) {
    let h = this.h;
    for (let i = 0; i < bytes.length; i++) {
      h = Math.imul(h ^ bytes[i], FNV_PRIME);
    }
    this.h = h;
  }
  digest() {
    return this.h >>> 0;
  }
}

export function fingerprintBytes(bytes) {
  const f = new Fingerprint();
  f.update(bytes);
  return f.digest();
}

// WritableStream sink that feeds every chunk into a Fingerprint and
// exposes the running instance. Lets validate-mode plumbing pipe the
// decoder's output directly into a hash without a buffering stage.
export function fingerprintSink() {
  const fp = new Fingerprint();
  const writable = new WritableStream({
    write(chunk) { fp.update(chunk); },
  });
  return { writable, fingerprint: fp };
}
