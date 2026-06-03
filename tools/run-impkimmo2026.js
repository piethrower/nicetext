#!/usr/bin/env node
// run-impkimmo2026.js: rebuild impkimmo2026.twlist.gz and its four
// variant twlists (cform / root / rootpos / drvstem) from
// fixture-src/wlist/master.wlist.gz, parallelizing the recognize pass
// across N concurrent shards.
//
// Usage:
//   node tools/run-impkimmo2026.js [--shards N]
//
//   --shards N   number of parallel pckimmo shards; default 20.
//                Each shard is a self-contained fetch.js subprocess
//                that reads its own ~1/N slice of master.wlist and
//                spawns its own series of timeout-wrapped pckimmo
//                child processes. 20 is the documented default per
//                project's empirical fit on the developer's machine.
//
// Pipeline:
//   1. Wipe tmp/shards/.
//   2. Split fixture-src/wlist/master.wlist.gz N ways, round-robin by
//      line number, gzip each shard.
//   3. Spawn N parallel fetch.js subprocesses, each writing
//      tmp/shards/out-${i}.twlist.gz and four sibling variant
//      outputs.
//   4. Wait for all subprocesses to exit.
//   5. For each of the 5 axes, run `sort -u -m` over the per-shard
//      outputs to produce the final merged file, written into
//      fixture-src/twlist/impkimmo2026/ via atomic rename so a kill
//      mid-merge can't corrupt the current artifact.
//   6. Print summary (rows / types / words per axis).
//
// Each fetch.js shard inherits its env from this process plus the
// per-shard MASTER_WLIST_PATH and per-axis output paths.

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import readline from 'node:readline';

const HERE  = dirname(fileURLToPath(import.meta.url));
const REPO  = dirname(HERE);
const MASTER_WLIST = join(REPO, 'fixture-src', 'wlist', 'master.wlist.gz');
const SHARDS_DIR   = join(REPO, 'tmp', 'shards');
const FETCH_JS     = join(REPO, 'fixture-src', 'twlist', 'impkimmo2026', 'fetch.js');
const FINAL_DIR    = join(REPO, 'fixture-src', 'twlist', 'impkimmo2026');

// Axes and their final output filenames inside FINAL_DIR. Order
// determines log + summary order.
const AXES = [
  { key: 'baseline', envVar: 'IMPKIMMO2026_OUT',         shardPrefix: 'out-',         final: 'impkimmo2026.twlist.gz' },
  { key: 'cform',    envVar: 'IMPKIMMO2026_CFORM_OUT',   shardPrefix: 'out-cform-',   final: 'impkimmo2026-cform.twlist.gz' },
  { key: 'root',     envVar: 'IMPKIMMO2026_ROOT_OUT',    shardPrefix: 'out-root-',    final: 'impkimmo2026-root.twlist.gz' },
  { key: 'rootpos',  envVar: 'IMPKIMMO2026_ROOTPOS_OUT', shardPrefix: 'out-rootpos-', final: 'impkimmo2026-rootpos.twlist.gz' },
  { key: 'drvstem',  envVar: 'IMPKIMMO2026_DRVSTEM_OUT', shardPrefix: 'out-drvstem-', final: 'impkimmo2026-drvstem.twlist.gz' },
];

function parseShards(argv) {
  const i = argv.indexOf('--shards');
  if (i < 0) return 20;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(`run-impkimmo2026: invalid --shards "${argv[i + 1]}"\n`);
    process.exit(2);
  }
  return n;
}

function zpad(n, width) {
  return String(n).padStart(width, '0');
}

async function splitMasterWlist(SHARDS) {
  process.stderr.write(`[1/4] splitting ${MASTER_WLIST} → ${SHARDS} shards...\n`);
  rmSync(SHARDS_DIR, { recursive: true, force: true });
  mkdirSync(SHARDS_DIR, { recursive: true });

  const width = String(SHARDS - 1).length;
  // Open one createWriteStream per shard with a gzip transform.
  const outs = [];
  for (let i = 0; i < SHARDS; i++) {
    const p = join(SHARDS_DIR, `shard-${zpad(i, width)}.wlist.gz`);
    const gz = createGzip({ level: 6 });
    const ws = createWriteStream(p);
    gz.pipe(ws);
    outs.push({ p, gz, ws });
  }

  const rl = readline.createInterface({
    input: createReadStream(MASTER_WLIST).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  let n = 0;
  for await (const line of rl) {
    const o = outs[n % SHARDS];
    if (!o.gz.write(line + '\n')) {
      await new Promise(res => o.gz.once('drain', res));
    }
    n++;
  }
  await Promise.all(outs.map(o => new Promise((res, rej) => {
    o.gz.end();
    o.ws.on('close', res);
    o.ws.on('error', rej);
  })));
  process.stderr.write(`       wrote ${SHARDS} shards covering ${n} words.\n`);
  return { lines: n, width };
}

async function runShards(SHARDS, width) {
  process.stderr.write(`[2/4] spawning ${SHARDS} parallel fetch.js shards...\n`);
  const procs = [];
  for (let i = 0; i < SHARDS; i++) {
    const id = zpad(i, width);
    const env = { ...process.env };
    env.MASTER_WLIST_PATH = join(SHARDS_DIR, `shard-${id}.wlist.gz`);
    for (const a of AXES) env[a.envVar] = join(SHARDS_DIR, `${a.shardPrefix}${id}.twlist.gz`);
    env.FIELDS_OBSERVED_PATH = join(SHARDS_DIR, `fields-${id}.tsv`);
    const logFd = (await import('node:fs')).openSync(join(SHARDS_DIR, `log-${id}.log`), 'w');
    const p = spawn(process.execPath, [FETCH_JS], {
      env, stdio: ['ignore', logFd, logFd],
    });
    procs.push(p);
  }
  // Wait for all to exit. Collect exit codes.
  const exitCodes = await Promise.all(procs.map(p =>
    new Promise(res => p.on('exit', code => res(code)))));
  const failures = exitCodes.filter(c => c !== 0).length;
  if (failures) {
    process.stderr.write(`[2/4] WARN: ${failures}/${SHARDS} shards exited non-zero.\n`);
  } else {
    process.stderr.write(`[2/4] all ${SHARDS} shards exited cleanly.\n`);
  }
}

async function mergeAxis(axis, SHARDS, width) {
  // Each shard's per-axis output is already `sort -u`'d by fetch.js's
  // internal pipeline, so we use `sort -u -m` (merge mode) which is
  // linear in input size rather than O(n log n) for a full sort.
  const shardArgs = [];
  for (let i = 0; i < SHARDS; i++) {
    const id = zpad(i, width);
    const p = join(SHARDS_DIR, `${axis.shardPrefix}${id}.twlist.gz`);
    if (!existsSync(p)) {
      process.stderr.write(`       skip missing ${p}\n`);
      continue;
    }
    shardArgs.push(`<(zcat ${p})`);
  }
  const tmpFinal = join(FINAL_DIR, `.${axis.final}.tmp`);
  const finalPath = join(FINAL_DIR, axis.final);
  // Use bash -c so process substitution works.
  const cmd = `LC_ALL=C sort -u -m --parallel=${SHARDS} ${shardArgs.join(' ')} | gzip -9 > ${tmpFinal}`;
  await new Promise((res, rej) => {
    const sh = spawn('bash', ['-c', cmd], { stdio: ['ignore', 'inherit', 'inherit'] });
    sh.on('exit', c => c === 0 ? res() : rej(new Error(`merge failed (exit ${c})`)));
  });
  // Atomic rename. If a previous artifact is on disk it gets replaced
  // only once the merge is complete.
  (await import('node:fs')).renameSync(tmpFinal, finalPath);
}

async function mergeAll(SHARDS, width) {
  process.stderr.write(`[3/4] merging per-shard outputs (sort -u -m --parallel=${SHARDS})...\n`);
  if (!existsSync(FINAL_DIR)) mkdirSync(FINAL_DIR, { recursive: true });
  for (const axis of AXES) {
    process.stderr.write(`       ${axis.key}...\n`);
    await mergeAxis(axis, SHARDS, width);
  }
}

async function summarize() {
  process.stderr.write(`[4/4] summary:\n`);
  for (const axis of AXES) {
    const path = join(FINAL_DIR, axis.final);
    if (!existsSync(path)) { process.stderr.write(`       ${axis.key}: MISSING\n`); continue; }
    const size = statSync(path).size;
    // Count rows / types / words via zcat + awk. Each cheap (~seconds
    // even for the multi-million-row baseline).
    const { rows, types, words } = await new Promise((res, rej) => {
      const cmd = `zcat ${path} | awk 'BEGIN{r=0} {r++; t[$1]=1; w[$2]=1} END{print r, length(t), length(w)}'`;
      const sh = spawn('bash', ['-c', cmd]);
      let out = '';
      sh.stdout.on('data', d => { out += d; });
      sh.on('exit', () => {
        const [r, t, w] = out.trim().split(/\s+/).map(Number);
        res({ rows: r, types: t, words: w });
      });
      sh.on('error', rej);
    });
    process.stderr.write(`       ${axis.key.padEnd(10)} rows=${String(rows).padStart(10)}  types=${String(types).padStart(6)}  words=${String(words).padStart(10)}  ${(size/1024/1024).toFixed(1)} MiB  → ${axis.final}\n`);
  }
}

async function main() {
  const SHARDS = parseShards(process.argv.slice(2));
  process.stderr.write(`run-impkimmo2026: SHARDS=${SHARDS}\n`);

  if (!existsSync(MASTER_WLIST)) {
    process.stderr.write(`run-impkimmo2026: missing ${MASTER_WLIST}\n`);
    process.stderr.write(`  Run tools/build-master-wlist.js first.\n`);
    process.exit(1);
  }

  const t0 = Date.now();
  const { width } = await splitMasterWlist(SHARDS);
  await runShards(SHARDS, width);
  await mergeAll(SHARDS, width);
  await summarize();
  const dtMin = ((Date.now() - t0) / 60000).toFixed(1);
  process.stderr.write(`run-impkimmo2026: total wall time ${dtMin} min.\n`);
}

main().catch(e => {
  process.stderr.write(`run-impkimmo2026: FAILED: ${e.stack || e.message}\n`);
  process.exit(1);
});
