// Runtime-portable shim for `node:zlib`. Surface used by tests +
// helpers: gunzipSync, constants.
//
// Node path: delegates to real `node:zlib`. Real gunzip when a test
// reads a .gz fixture via real `readFileSync` and asks for plain
// bytes back.
// Browser path: identity, the node:fs shim already decompresses .gz
// fixtures at preload time, so readJsonMaybeGz et al. see plain text
// and never actually call gunzipSync. Throws clearly if a real gzip
// buffer slips through.

const isNode = typeof process !== 'undefined' && !!process?.versions?.node;

let gunzipSyncImpl;
let constantsImpl;

if (isNode) {
  const zlib = await import('node:zlib');
  gunzipSyncImpl = (input) => zlib.gunzipSync(input);
  constantsImpl  = zlib.constants;
} else {
  gunzipSyncImpl = (input) => {
    if (typeof input === 'string') return input;
    if (input && input[0] === 0x1f && input[1] === 0x8b) {
      throw new Error('node:zlib browser shim: real gzip buffer passed; node-fs shim should decompress at preload.');
    }
    return input;
  };
  constantsImpl = { Z_BEST_COMPRESSION: 9 };
}

export const gunzipSync = gunzipSyncImpl;
export const constants  = constantsImpl;

export default { gunzipSync, constants };
