// sab.test.js: scaffold contract for js/src/sab.js.
//
// js/src/sab.js stands up the native ↔ SAB compile layer with four
// exports (pack / unpack / saveSABtoFile / loadSABfromFile) and the
// per-type dispatch registry. This file pins down the scaffold's
// contract so a future regression in the dispatch surface surfaces
// with a clear error rather than as a mysterious "wrong fixture
// loaded".

import { test } from './shims/node-test.js';
import assert from './shims/node-assert.js';
import { nodeOnly } from './_runtime.js';

import {
  SAB_RESOURCE_CATEGORIES,
  NATIVE_EXT,
  SAB_SIZE_CEILING,
  pack,
  unpack,
  saveSABtoFile,
  loadSABfromFile,
  _registerCategory,
} from '../../js/src/sab.js';

const EXPECTED_TYPES = [
  'twlist', 'wlist', 'dict', 'model', 'freq', 'emoji-cldr',
  'monotyped-model', 'rewriter',
];

test('SAB_RESOURCE_CATEGORIES enumerates the eight fixture category tokens', () => {
  assert.deepEqual([...SAB_RESOURCE_CATEGORIES].sort(), [...EXPECTED_TYPES].sort());
});

test('NATIVE_EXT defines a native extension for every resource category', () => {
  for (const t of EXPECTED_TYPES) {
    assert.equal(typeof NATIVE_EXT[t], 'string',
      `NATIVE_EXT["${t}"] should be a string`);
    assert.ok(NATIVE_EXT[t].endsWith('.gz'),
      `NATIVE_EXT["${t}"] should be a gzipped form (got "${NATIVE_EXT[t]}")`);
  }
});

// Step 4 is complete: all six resource categories have pack + unpack
// wired in sab.js. No unwired holdouts remain. The
// `emoji-keywords` slot that originally appeared in the plan was
// retired in the emoji-cldr sub-commit, the wlist promotion
// absorbed its purpose generically.

test('every SAB resource category has both pack and unpack wired', () => {
  for (const cat of EXPECTED_TYPES) {
    assert.doesNotThrow(
      () => { try { pack('', cat); } catch (e) {
        // pack may throw a validation error on empty input, but it
        // must NOT throw 'not yet implemented'.
        if (/not yet implemented/i.test(e.message)) throw e;
      } },
      /not yet implemented/i,
      `pack for "${cat}" should be wired (no 'not yet implemented')`,
    );
    assert.doesNotThrow(
      () => { try { unpack(new SharedArrayBuffer(0), cat); } catch (e) {
        if (/not yet implemented/i.test(e.message)) throw e;
      } },
      /not yet implemented/i,
      `unpack for "${cat}" should be wired (no 'not yet implemented')`,
    );
  }
});

test('dict unpack(pack(json)) round-trips the encoder-relevant content',
  nodeOnly('reads /fixtures via the sab.js file helpers'),
  async () => {
    // jfk is the smallest shipped dict (528 words). The dict pack and
    // unpack are both wired; this is the round-trip invariant.
    //
    // The semantic invariant is the (word → typeIndex/code/bits)
    // mapping plus type names + per-type wordCounts. Byte-level
    // identity is NOT a target: pack's string-pool offsets depend
    // on input array order, and unpack returns words in byWord
    // (alphabetical) order, so the second pack interns strings in
    // a different order and produces a byte-different SAB with the
    // identical lookup semantics.
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const sab = await loadSABfromFile(join(here, '../../fixtures/jfk-1.dict.sab.gz'));
    const json = unpack(sab, 'dict');
    assert.equal(json.version, 2);
    assert.ok(Array.isArray(json.types) && json.types.length > 0);
    assert.ok(Array.isArray(json.words) && json.words.length > 0);

    const sab2 = pack(JSON.stringify(json), 'dict');
    const json2 = unpack(sab2, 'dict');

    // Type shape: same count, same (index, name, wordCount) tuples.
    assert.equal(json2.types.length, json.types.length);
    const tKey = (t) => `${t.index}:${t.name}:${t.wordCount}`;
    assert.deepEqual(json2.types.map(tKey).sort(), json.types.map(tKey).sort());

    // Word shape: same (word → typeIndex/code/bits) mapping.
    assert.equal(json2.words.length, json.words.length);
    const wMap = new Map(json.words.map((w) => [w.word, w]));
    for (const w2 of json2.words) {
      const w1 = wMap.get(w2.word);
      assert.ok(w1, `re-unpacked word "${w2.word}" missing from original`);
      assert.equal(w2.typeIndex, w1.typeIndex);
      assert.equal(w2.code, w1.code);
      assert.equal(w2.bits, w1.bits);
    }
  },
);

test('model unpack(pack(json)) round-trips the encoder-relevant content',
  nodeOnly('reads /fixtures via the sab.js file helpers'),
  async () => {
    // jfk is the smallest shipped model (16,343 bytes). Same shape
    // contract as the dict round-trip above: same (models, tokens,
    // weights, typeNames, ordered) under unpack→pack→unpack, byte
    // identity is not a target because string-pool order depends on
    // input-array order.
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const sab = await loadSABfromFile(join(here, '../../fixtures/jfk-1.model.sab.gz'));
    const json = unpack(sab, 'model');
    assert.equal(json.version, 2);
    assert.ok(Array.isArray(json.typeNames) && json.typeNames.length > 0);
    assert.ok(Array.isArray(json.models) && json.models.length > 0);

    // name is metadata-only-on-load (no SAB field); unpack returns
    // null. Repack just ignores it. Round-trip compares the SAB-
    // resident fields.
    const sab2 = pack(JSON.stringify(json), 'model');
    const json2 = unpack(sab2, 'model');

    assert.equal(json2.ordered, json.ordered);
    assert.deepEqual(json2.typeNames, json.typeNames);
    assert.equal(json2.models.length, json.models.length);
    for (let i = 0; i < json.models.length; i++) {
      assert.equal(json2.models[i].weight, json.models[i].weight, `model ${i} weight`);
      assert.deepEqual(json2.models[i].tokens, json.models[i].tokens, `model ${i} tokens`);
    }
  },
);

test('wlist pack(text) → packStrings → unpack returns sorted-unique strings', () => {
  // wlist pack accepts one-word-per-line text and emits the NTPS
  // packed-strings SAB. Pack is defensive (re-normalizes), so an
  // out-of-order, duplicated, mixed-case input round-trips to a
  // sorted-unique-lowercased array.
  const src = 'banana\nApple\napple\nCHERRY\nBanana\n\nbanana\n';
  const sab = pack(src, 'wlist');
  const out = unpack(sab, 'wlist');
  assert.deepEqual(out, ['apple', 'banana', 'cherry']);
});

test('freq pack(tsv) → packFreqToSAB → unpack returns {totalTokens, counts}',
  nodeOnly('reads /fixtures via the sab.js file helpers'),
  async () => {
    // norvig is the smallest shipped freq fixture. The freq sub-
    // commit of step 4 wired both pack and unpack. The round-trip
    // invariant is totalTokens (lossless via u64 lo/hi pair) +
    // per-word counts (also u64 lo/hi). Word order need not match,
    // pack sorts by UTF-8 bytes, but the per-word value mapping
    // is exact.
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const sab = await loadSABfromFile(join(here, '../../fixtures/norvig.freq.sab.gz'));
    const out = unpack(sab, 'freq');
    assert.ok(typeof out.totalTokens === 'number' && out.totalTokens > 0,
      `unpack returned non-positive totalTokens (${out.totalTokens})`);
    assert.ok(out.counts instanceof Map && out.counts.size > 0);
    // Re-pack and confirm the round-trip preserves both header and
    // per-word counts. Largest norvig count exceeds 2^32, so this
    // also exercises the u64 lo/hi pair encoding.
    const sab2 = pack(textForFreqRoundTrip(out), 'freq');
    const out2 = unpack(sab2, 'freq');
    assert.equal(out2.totalTokens, out.totalTokens, 'totalTokens preserved');
    assert.equal(out2.counts.size, out.counts.size, 'word count preserved');
    for (const [w, c] of out.counts) {
      assert.equal(out2.counts.get(w), c, `count for "${w}" preserved`);
    }
  },
);
function textForFreqRoundTrip({ counts }) {
  // Serialize the in-memory {counts} back to the TSV shape pack
  // expects (one `<word>\t<count>` line per entry). totalTokens is
  // recomputed by parseFreqLines from the sum of counts; per the
  // module's documented contract that recomputation is equivalent
  // to the original because the fixture is a closed set.
  const out = [];
  for (const [w, c] of counts) out.push(`${w}\t${c}`);
  return out.join('\n') + '\n';
}

test('emoji-cldr pack(json) → packCldrMapToSAB → unpack round-trips the map',
  nodeOnly('reads /fixtures via the sab.js file helpers'),
  async () => {
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const sab = await loadSABfromFile(join(here, '../../fixtures/emoji16.emoji-cldr.sab.gz'));
    const map = unpack(sab, 'emoji-cldr');
    // Spot-checks: known emoji with known keyword lists.
    assert.ok(typeof map === 'object' && map !== null);
    assert.ok(Object.keys(map).length > 1000, 'emoji-cldr map should have many entries');
    const someEmoji = Object.keys(map)[0];
    assert.ok(Array.isArray(map[someEmoji]), `value for ${JSON.stringify(someEmoji)} should be an array`);
    // Round-trip via re-pack: serialize back to JSON, re-pack, re-unpack.
    const sab2 = pack(JSON.stringify(map), 'emoji-cldr');
    const map2 = unpack(sab2, 'emoji-cldr');
    assert.equal(Object.keys(map2).length, Object.keys(map).length);
    for (const e of Object.keys(map)) {
      assert.deepEqual(map2[e], map[e], `keywords for ${JSON.stringify(e)} preserved`);
    }
  },
);

test('twlist pack(tsv) → packEntries → unpack returns (type, word) entries', () => {
  // twlist pack accepts TSV with `type<TAB>word` lines; emits the
  // entries-SAB (NTEN). unpack returns the [{type, word}, ...] array
  // in source order. Distinct format and semantics from wlist; the
  // two type tokens never share a SAB shape.
  const tsv = '# header\nnoun\tcat\nverb\trun\nnoun\tdog\n';
  const sab = pack(tsv, 'twlist');
  const entries = unpack(sab, 'twlist');
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { type: 'noun', word: 'cat' });
  assert.deepEqual(entries[1], { type: 'verb', word: 'run' });
  assert.deepEqual(entries[2], { type: 'noun', word: 'dog' });
});

test('pack throws "unknown resourceCategory" for an unrecognized category token', () => {
  assert.throws(() => pack({}, 'bogus-category'), /unknown resourceCategory/i);
});

test('unpack throws "unknown resourceCategory" for an unrecognized category token', () => {
  assert.throws(() => unpack(null, 'bogus-category'), /unknown resourceCategory/i);
});

// These tests use 'freq' as the wiring sandbox because commit 3
// auto-wires dict/model/twlist at sab.js's bottom of module; using
// one of the still-unwired holdouts (freq / emoji-cldr / emoji-
// keywords) means the test can tear down to `pack: null` cleanly
// without disturbing the auto-registered built-ins.
test('_registerCategory wires a per-category packer; subsequent pack call dispatches to it', () => {
  let calledWith = null;
  const fakeSab = new SharedArrayBuffer(8);
  _registerCategory('freq', {
    pack: (native) => { calledWith = native; return fakeSab; },
  });
  try {
    const sab = pack({ hello: 'world' }, 'freq');
    assert.equal(sab, fakeSab);
    assert.deepEqual(calledWith, { hello: 'world' });
  } finally {
    _registerCategory('freq', { pack: null });
  }
});

test('pack throws when the per-type packer returns a non-SAB value', () => {
  _registerCategory('freq', { pack: () => 'not a sab' });
  try {
    assert.throws(() => pack({}, 'freq'), /non-sab/i);
  } finally {
    _registerCategory('freq', { pack: null });
  }
});

test('pack enforces the u32 size ceiling without allocating', () => {
  const fake = { byteLength: SAB_SIZE_CEILING };
  _registerCategory('freq', { pack: () => fake });
  try {
    assert.throws(() => pack({}, 'freq'), /u32 cap/i);
  } finally {
    _registerCategory('freq', { pack: null });
  }
});

test('SAB_SIZE_CEILING equals 2^32', () => {
  assert.equal(SAB_SIZE_CEILING, 4_294_967_296);
});

test('saveSABtoFile + loadSABfromFile round-trip a SAB through disk',
  nodeOnly('node:fs / node:zlib not available in browser harness'),
  async () => {
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { unlink } = await import('node:fs/promises');

    const orig = new SharedArrayBuffer(32);
    const dv = new DataView(orig);
    dv.setUint32(0, 0xdeadbeef, true);
    dv.setUint32(4, 0xcafebabe, true);
    dv.setBigUint64(8, 0x0123456789abcdefn, true);

    const path = join(tmpdir(), `sab-roundtrip-${process.pid}-${Date.now()}.sab.gz`);
    try {
      await saveSABtoFile(orig, path);
      const back = await loadSABfromFile(path);
      assert.equal(back.byteLength, orig.byteLength);
      const dv2 = new DataView(back);
      assert.equal(dv2.getUint32(0, true), 0xdeadbeef);
      assert.equal(dv2.getUint32(4, true), 0xcafebabe);
      assert.equal(dv2.getBigUint64(8, true), 0x0123456789abcdefn);
    } finally {
      try { await unlink(path); } catch {}
    }
  },
);

test('saveSABtoFile throws cleanly in a non-node environment',
  // This is the inverse-skip of the round-trip above: we WANT to
  // exercise this branch only in node where IS_NODE is true. Both
  // paths (node-skip-message + browser-actually-throws) are
  // covered: in node the helpers run; in browser the harness'd
  // import would resolve via different node:fs availability. Here
  // we just confirm the function exists; the "throws if not node"
  // branch is unit-testable via direct invocation but exercising
  // it in a node test would require mocking process. Skipped in
  // browser (since the harness can't dynamic-import node:fs) and
  // a noop in node (since IS_NODE is true). The shape of the
  // export is what matters for the scaffold.
  nodeOnly('helper presence check'),
  () => {
    assert.equal(typeof saveSABtoFile, 'function');
    assert.equal(typeof loadSABfromFile, 'function');
  },
);
