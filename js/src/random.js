// Small deterministic PRNGs. Returns floats in [0, 1) like Math.random
// so the same generator works for weighted-pick (random() * total) and
// byte generation (Math.floor(random() * 256)).
//
// Browser-safe ESM. No Node deps.

// mulberry32: 32-bit state, returns a float in [0, 1).
export function mulberry32(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}
