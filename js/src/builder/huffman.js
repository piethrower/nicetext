// Huffman code builder. Produces variable-length prefix codes for a set of
// items, weighted by frequency. Common items get short codes; rare items
// get long codes. Single-item input gets a 0-bit code.
//
// Browser-safe ESM. No Node deps.

class MinHeap {
  constructor(cmp) { this.heap = []; this.cmp = cmp; }
  get size() { return this.heap.length; }
  push(x) {
    const a = this.heap;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) < 0) { [a[i], a[p]] = [a[p], a[i]]; i = p; }
      else break;
    }
  }
  pop() {
    const a = this.heap;
    const top = a[0];
    const last = a.pop();
    if (a.length === 0) return top;
    a[0] = last;
    const n = a.length;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.cmp(a[l], a[smallest]) < 0) smallest = l;
      if (r < n && this.cmp(a[r], a[smallest]) < 0) smallest = r;
      if (smallest === i) break;
      [a[i], a[smallest]] = [a[smallest], a[i]]; i = smallest;
    }
    return top;
  }
}

// items: Array<{ item: any, weight: number }>.
// Returns: Array<{ item, code, bits }> in the same order as the input.
//   - code: integer value of the code
//   - bits: length of the code (0 for a single-item set)
// We use Number arithmetic (multiply by 2 + bit) instead of bit-shifts so
// codes longer than 30 bits don't overflow JS's signed-int bitwise ops.
// Codes up to 50 bits are safe; beyond that we'd need BigInt.
export function buildHuffman(items) {
  if (items.length === 0) return [];
  if (items.length === 1) return [{ item: items[0].item, code: 0, bits: 0 }];

  // Heap entries are nodes. Tie-break by insertion order for determinism.
  const heap = new MinHeap((a, b) => a.weight - b.weight || a.order - b.order);
  let nextOrder = 0;
  for (const { item, weight } of items) {
    heap.push({ weight, leaf: true, item, order: nextOrder++ });
  }

  while (heap.size > 1) {
    const a = heap.pop();
    const b = heap.pop();
    heap.push({
      weight: a.weight + b.weight,
      leaf: false, left: a, right: b, order: nextOrder++,
    });
  }

  const root = heap.pop();
  const lookup = new Map(); // item → { code, bits }
  // Iterative DFS over the Huffman tree. Recursion blew the JS stack
  // on Flood-style inputs where one type carries hundreds of thousands
  // of entries with skewed weights, the tree can grow much deeper
  // than the engine's ~10k-frame call-stack limit.
  const stack = [{ node: root, code: 0, bits: 0 }];
  while (stack.length > 0) {
    const { node, code, bits } = stack.pop();
    if (node.leaf) { lookup.set(node.item, { code, bits }); continue; }
    // Push right first so left is visited next (matches the original
    // recursion's left-then-right order; not load-bearing for output
    // since lookup is keyed by item, but keeps codes stable).
    stack.push({ node: node.right, code: code * 2 + 1, bits: bits + 1 });
    stack.push({ node: node.left,  code: code * 2 + 0, bits: bits + 1 });
  }

  // Return in original input order.
  return items.map(({ item }) => {
    const c = lookup.get(item);
    return { item, code: c.code, bits: c.bits };
  });
}

// Verify Kraft's inequality (sum of 2^-bits over all codewords ≤ 1) and
// that the codes are prefix-free. Useful as a build-time invariant check.
export function verifyHuffman(coded) {
  if (coded.length === 0) return true;
  if (coded.length === 1) return coded[0].bits === 0;

  // Kraft sum
  let kraft = 0;
  for (const { bits } of coded) kraft += Math.pow(2, -bits);
  // Allow tiny floating-point error
  if (kraft > 1.0 + 1e-9) {
    throw new Error(`Huffman: Kraft inequality violated (${kraft})`);
  }

  // Prefix-free: serialize codes as bit strings, sort, walk; no entry may
  // be a prefix of the next.
  const strs = coded.map(({ code, bits }) =>
    bits === 0 ? '' : code.toString(2).padStart(bits, '0')
  );
  strs.sort();
  for (let i = 0; i + 1 < strs.length; i++) {
    if (strs[i + 1].startsWith(strs[i])) {
      throw new Error(`Huffman: code "${strs[i]}" is a prefix of "${strs[i + 1]}"`);
    }
  }
  return true;
}
