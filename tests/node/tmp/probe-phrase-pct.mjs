import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { listDictWords, wrapDictionaryFromSAB } from '../../../js/src/dictionary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', '..', 'fixtures');

const names = readdirSync(FIXTURES).filter(n => n.endsWith('-1.dict.sab.gz')).sort();
const rows = [];
for (const n of names) {
  const buf = gunzipSync(readFileSync(join(FIXTURES, n)));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dict = wrapDictionaryFromSAB(ab);
  const words = listDictWords(dict);
  const phraseCount = words.filter(w => w.includes(' ')).length;
  const total = words.length;
  rows.push({ name: n.replace('-1.dict.sab.gz',''), total, phraseCount, pct: 100*phraseCount/total });
}
rows.sort((a,b) => a.pct - b.pct);
for (const r of rows) console.log(`${r.name.padEnd(24)}  ${String(r.phraseCount).padStart(7)} / ${String(r.total).padStart(7)} = ${r.pct.toFixed(3)}%`);
const lo = rows[0], hi = rows[rows.length-1];
console.log(`---\nRange: ${lo.pct.toFixed(3)}% (${lo.name})  to  ${hi.pct.toFixed(3)}% (${hi.name})`);
