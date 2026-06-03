# Confusables: raw/cooked/fetch.js build plan

Goal: bring the Unicode TR39 confusables data under the same
`fetch.js → raw/ → cooked/ → /fixtures` paradigm used by
`fixture-src/freq/*`, so the public repo carries only our derived,
attributed artifact (not Unicode's verbatim file), and the
"wipe `/fixtures`, rebuild" test stays hermetic.

## Layout (mirrors fixture-src/freq/<source>/)

```
fixture-src/confusables/
  .gitignore                  raw/            (ignore the ephemeral download)
  fetch.js                    downloads Unicode confusables.txt v15.1.0 -> raw/
  raw/confusables.txt         gitignored, ephemeral, only after a dev runs fetch.js
  cooked/confusables-data.js  COMMITTED, authoritative baked Map (network-free source of truth)
```

`/fixtures/confusables-data.js` is the deployed copy the engine imports
(committed, regenerable by wiping and rerunning build-all-fixtures).

## Data flow

`raw/` (gitignored) -> `cooked/` (committed) -> `/fixtures/` (copied,
wipe-and-rebuildable). Day to day, only `cooked` and `/fixtures` exist
and are consumed. `raw/` appears only when a maintainer bumps the
Unicode version.

## Steps

1. `fixtures/confusables-data.js` — deployed copy (verbatim of cooked).
2. `tools/sab-fixtures-guard.js` — allowlist `confusables-data.js`
   (its node test imports the allowlist, so it mirrors automatically).
3. `fixture-src/confusables/fetch.js` — download v15.1.0 into `raw/`,
   attribution header (URL, version, license).
4. `tools/build-confusables-map.js` — read `raw/confusables.txt`, emit
   `cooked/confusables-data.js`. mtime-staleness: raw absent OR not
   newer than cooked -> no-op (cooked is authoritative). Only a fresh
   `fetch.js` makes raw newer and triggers a rebuild.
5. `tools/build-all-fixtures.js` — new step right after `0a`
   (cards.data.js), before any preclean-dependent corpus/dict/model
   build: run build-confusables-map (no-op normally), then copy
   `cooked/confusables-data.js` -> `fixtures/confusables-data.js`.
   Must be early because `precleanCorpus.js` is wired into
   `genmodel.js` / `listword.js`.
6. `js/src/builder/precleanCorpus.js` — import `CONFUSABLES` from
   `../../../fixtures/confusables-data.js` (matches how `cards.data.js`
   and `twlist-sources.meta.js` are imported from `/fixtures`).
7. Delete `js/src/builder/confusables-data.js` (no shim; replace in one
   commit).
8. Update references: `attributions.html`, `docs/pre-cleaning-corpus-rules.md`,
   `docs/cli.md`.

## Verification

- `node tools/build-confusables-map.js` -> no-op (raw empty), cooked unchanged.
- `node --test tests/node/precleanCorpus.test.js tests/node/sab-fixtures-guard.test.js`
  -> import resolves from `/fixtures`, folding works, guard allows the new file.
- Playwright: load a page that imports `precleanCorpus.js` and folds a
  confusable in-browser, confirming the worker resolves
  `/fixtures/confusables-data.js` under CSP.
