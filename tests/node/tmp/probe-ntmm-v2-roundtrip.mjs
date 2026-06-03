// probe-ntmm-v2-roundtrip.mjs: round-trip smoke for the v2 NTMM
// layout. Builds two synthetic ordered MM lists, packs each, wraps,
// and exercises every new and existing method on both views.

import {
  packMonotypedModel,
  wrapMonotypedModel,
  collapsedMonotypedModel,
  MONO_TYPE,
} from '../../../js/src/eve/monotyped-model-sab.js';

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// Synthetic MMs. Mix of:
//   - identical raw MMs across the two sets (test exact match)
//   - same-CMM but different MMs (test variant match)
//   - unique to one side (test no match)
const setA = [
  'Cap|g|g|,|g|g|g|.',       // CMM: Cap|g|,|g|.
  'Cap|g|g|,|g|g|g|.',       // repeat: tests dedupe + ordered-index
  'Cap|g|.',                  // CMM: Cap|g|.
  'Cap|g|g|g|g|.',            // CMM: Cap|g|.   <-- same CMM as Cap|g|.
  '{Caps}|g|!|',              // CMM: {Caps}|g|!|
];
const setB = [
  'Cap|g|.',                  // exact match w/ A
  'Cap|g|g|.',                // CMM: Cap|g|.   <-- variant-only match w/ A
  'g|g|?',                    // CMM: g|?       <-- no match
];

const viewA = wrapMonotypedModel(packMonotypedModel(setA));
const viewB = wrapMonotypedModel(packMonotypedModel(setB));

// MONO_TYPE export sanity.
assert(MONO_TYPE === 'g', 'MONO_TYPE === g');

// collapsedMonotypedModel direct check.
assert(collapsedMonotypedModel('Cap|g|g|,|g|g|g|.') === 'Cap|g|,|g|.', 'collapse 1');
assert(collapsedMonotypedModel('Cap|g|.') === 'Cap|g|.', 'collapse idempotent on already-collapsed');
assert(collapsedMonotypedModel('g|g|g|g') === 'g', 'collapse all g run');
assert(collapsedMonotypedModel('a|b|c') === 'a|b|c', 'collapse no g changes');

// Counts.
assert(viewA.orderedCount === 5, `A.orderedCount = ${viewA.orderedCount}, want 5`);
// Unique MMs in A: 4 (one duplicate)
assert(viewA.uniqueCount === 4, `A.uniqueCount = ${viewA.uniqueCount}, want 4`);
// Unique CMMs in A: 3 (Cap|g|,|g|. , Cap|g|. , {Caps}|g|!|)
assert(viewA.cmmUniqueCount === 3, `A.cmmUniqueCount = ${viewA.cmmUniqueCount}, want 3`);

assert(viewB.orderedCount === 3, `B.orderedCount = ${viewB.orderedCount}`);
assert(viewB.uniqueCount === 3, `B.uniqueCount = ${viewB.uniqueCount}`);
// Unique CMMs in B: 2 (Cap|g|. , g|?)
assert(viewB.cmmUniqueCount === 2, `B.cmmUniqueCount = ${viewB.cmmUniqueCount}, want 2`);

// at(i) round-trip.
for (let i = 0; i < setA.length; i++) {
  assert(viewA.at(i) === setA[i], `A.at(${i}) = ${viewA.at(i)} want ${setA[i]}`);
}

// hasSorted true positives and a negative.
assert(viewA.hasSorted('Cap|g|.'), 'A has Cap|g|.');
assert(viewA.hasSorted('Cap|g|g|,|g|g|g|.'), 'A has Cap|g|g|,|g|g|g|.');
assert(!viewA.hasSorted('not-in-A'), 'A lacks not-in-A');

// cmmHasSorted true positive + negative.
assert(viewA.cmmHasSorted('Cap|g|.'), 'A cmm has Cap|g|.');
assert(viewA.cmmHasSorted('Cap|g|,|g|.'), 'A cmm has Cap|g|,|g|.');
assert(!viewA.cmmHasSorted('not-in-A'), 'A cmm lacks not-in-A');

// cmmIndexOfUnique / cmmIndexOfOrdered / cmmAtOrdered.
for (let i = 0; i < setA.length; i++) {
  const cmm = viewA.cmmAtOrdered(i);
  assert(cmm === collapsedMonotypedModel(setA[i]),
    `A.cmmAtOrdered(${i}) = ${cmm}, want ${collapsedMonotypedModel(setA[i])}`);
}

// Cross-sab: exactMatchAtOrdered + variantMatchAtOrdered.
//   A[0] = 'Cap|g|g|,|g|g|g|.', not exact in B, not variant in B (B has no Cap|g|,|g|. CMM)
//   A[2] = 'Cap|g|.'          : exact in B AND variant in B
//   A[3] = 'Cap|g|g|g|g|.'    : not exact in B, variant in B (both have CMM Cap|g|.)
//   A[4] = '{Caps}|g|!|'      : not exact, not variant
assert(!viewA.exactMatchAtOrdered(viewB, 0), 'A[0] not exact in B');
assert(!viewA.variantMatchAtOrdered(viewB, 0), 'A[0] not variant in B');
assert(viewA.exactMatchAtOrdered(viewB, 2), 'A[2] exact in B');
assert(viewA.variantMatchAtOrdered(viewB, 2), 'A[2] variant in B');
assert(!viewA.exactMatchAtOrdered(viewB, 3), 'A[3] not exact in B');
assert(viewA.variantMatchAtOrdered(viewB, 3), 'A[3] variant in B');
assert(!viewA.exactMatchAtOrdered(viewB, 4), 'A[4] not exact in B');
assert(!viewA.variantMatchAtOrdered(viewB, 4), 'A[4] not variant in B');

// Reverse direction.
//   B[0] = 'Cap|g|.'    exact in A, variant in A
//   B[1] = 'Cap|g|g|.'  not exact in A (A has Cap|g|. and Cap|g|g|g|g|. but not Cap|g|g|.), variant in A (CMM=Cap|g|.)
//   B[2] = 'g|g|?'      not exact, not variant
assert(viewB.exactMatchAtOrdered(viewA, 0), 'B[0] exact in A');
assert(viewB.variantMatchAtOrdered(viewA, 0), 'B[0] variant in A');
assert(!viewB.exactMatchAtOrdered(viewA, 1), 'B[1] not exact in A');
assert(viewB.variantMatchAtOrdered(viewA, 1), 'B[1] variant in A');
assert(!viewB.exactMatchAtOrdered(viewA, 2), 'B[2] not exact in A');
assert(!viewB.variantMatchAtOrdered(viewA, 2), 'B[2] not variant in A');

// SharedArrayBuffer round-trip.
const sabShared = packMonotypedModel(setA, { shared: true });
assert(sabShared instanceof SharedArrayBuffer, 'shared opt yields SAB');
const viewShared = wrapMonotypedModel(sabShared);
assert(viewShared.uniqueCount === viewA.uniqueCount, 'shared uniqueCount matches');
assert(viewShared.cmmUniqueCount === viewA.cmmUniqueCount, 'shared cmmUniqueCount matches');
assert(viewShared.cmmAtOrdered(3) === collapsedMonotypedModel(setA[3]), 'shared cmmAtOrdered ok');

// Bad-magic + bad-version rejection.
const badBuf = new ArrayBuffer(40);
let threw = false;
try { wrapMonotypedModel(badBuf); } catch { threw = true; }
assert(threw, 'rejects bad magic');

const badVer = packMonotypedModel(setA);
new DataView(badVer).setUint32(4, 1, true);
threw = false;
try { wrapMonotypedModel(badVer); } catch { threw = true; }
assert(threw, 'rejects v1 magic-correct-version-1 buffer');

console.log('OK, all v2 NTMM round-trip checks pass');
