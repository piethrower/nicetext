// typehash.js: fixed-size hash for sortDict's merged-type strings.
//
// Replaces comma-joined merged-type strings (which can exceed sab-pack's
// u16 length ceiling at full-flood configurations, word "hand" lands
// at ~190KB) with an 11-char URL-safe base64 encoding of a u64 hash.
// Downstream code treats type strings as opaque keys (verified across
// dct2mstr, genmodel, sab-pack, dictionary, modeltable, encode/decode,
// sources, app), so the swap is invisible to every consumer except
// sortDict's own re-merge logic, which now sees each prior-hash as a
// single atomic token instead of comma-splitting back into hundreds of
// atomics, fixing the iter-2 cross-feed amplification.
//
// dehashDict reverses the process by walking the dict's type table and
// resolving each hash via the typehash map (which sortDict optionally
// populates during the build). Recursion handles layered hashes, a
// layer-2 entry's stored string may contain layer-1 hashes as tokens.
//
// Browser-safe ESM. Pure transforms; no fs/dom.

const FNV_OFFSET_1 = 0x811c9dc5;
const FNV_OFFSET_2 = 0xcbf29ce4;
const FNV_PRIME    = 0x01000193;
const ENCODER = new TextEncoder();

function fnv32(bytes, seed) {
  let h = seed;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

// u64 hash via two independent FNV-1a passes; encoded as 11-char
// URL-safe base64 (no padding). Deterministic across runs and platforms
// because TextEncoder always emits UTF-8 and FNV is byte-deterministic.
export function hashMergedType(joined) {
  const bytes = ENCODER.encode(joined);
  const h1 = fnv32(bytes, FNV_OFFSET_1);
  const h2 = fnv32(bytes, FNV_OFFSET_2);
  const buf = new Uint8Array(8);
  buf[0] = h1        & 0xFF;
  buf[1] = (h1 >> 8) & 0xFF;
  buf[2] = (h1 >> 16) & 0xFF;
  buf[3] = (h1 >>> 24) & 0xFF;
  buf[4] = h2        & 0xFF;
  buf[5] = (h2 >> 8) & 0xFF;
  buf[6] = (h2 >> 16) & 0xFF;
  buf[7] = (h2 >>> 24) & 0xFF;
  return bytesToBase64UrlNoPad(buf);
}

// URL-safe base64 (RFC 4648 §5), no padding. Browser-safe, avoids
// Buffer (Node-only) and atob/btoa (browser-specific encoding quirks).
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function bytesToBase64UrlNoPad(bytes) {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 0x3) << 4) | (b >> 4)];
    out += B64[((b & 0xF) << 2) | (c >> 6)];
    out += B64[c & 0x3F];
  }
  if (i < bytes.length) {
    const a = bytes[i];
    if (i + 1 === bytes.length) {
      out += B64[a >> 2];
      out += B64[(a & 0x3) << 4];
    } else {
      const b = bytes[i + 1];
      out += B64[a >> 2];
      out += B64[((a & 0x3) << 4) | (b >> 4)];
      out += B64[(b & 0xF) << 2];
    }
  }
  return out;
}

// Dehash a dict produced with hashedMergedTypes=true, using the typehash
// map collected during the build. Returns a NEW dict object (does not
// mutate the input) where each type's name is the recursively-resolved
// comma-joined merged-type string.
//
// The map's values may contain other hashes as comma-separated tokens
// (layered hashes from the t0-pre-collapse sortDict feeding into the
// final sortDict). Each token is recursively resolved; non-hash tokens
// (atomic types like "begins_with_a_vowel" or original source types)
// pass through unchanged.
//
// Cycle protection: hashing is content-derived, so a hash cannot
// transitively reference itself. We rely on that invariant.
export function dehashDict(dict, typehashMap) {
  const cache = new Map();
  function resolve(tok) {
    if (cache.has(tok)) return cache.get(tok);
    if (!typehashMap.has(tok)) {
      cache.set(tok, tok);
      return tok;
    }
    const stored = typehashMap.get(tok);
    const expanded = new Set();
    for (const t of stored.split(',')) {
      const r = resolve(t);
      for (const part of r.split(',')) {
        if (part) expanded.add(part);
      }
    }
    const out = [...expanded].sort().join(',');
    cache.set(tok, out);
    return out;
  }
  return {
    ...dict,
    types: dict.types.map(t => ({ ...t, name: resolve(t.name) })),
  };
}
