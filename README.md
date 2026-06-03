# NiceText (JavaScript port)

Modern JavaScript port of **NiceText**, a 1995–2001 linguistic-steganography system by Mark T. Chapman and Dr. George Davida (UW-Milwaukee). Encodes any binary file as pseudo-natural-language text and recovers it losslessly.

## Status

See [`docs/architecture-overview.md`](docs/architecture-overview.md) for the design, target architecture, and engine module surface.

The original C++ source is preserved verbatim in a sibling [`OG-NiceText-C++`](../OG-NiceText-C++) archive repository, read-only. File-level pointers throughout this codebase (e.g. `OG-NiceText-C++/nicetext-1.0/gendict/src/sorttwl.cc`) name paths inside that archive.

## Layout

```
index.html, nicetext.html  site pages (served by tools/serve.sh)
css/         page stylesheets
img/         page images and SVG assets
js/          web app entrypoints (app.js, penny.js, tutorial-script.js)
js/src/      browser-safe ESM core (no Node deps; runs in Node and browsers)
js/bin/      Node CLI wrappers (nicetext, scramble, gendict)
tests/node/  node --test runner (browser-runnable via tests/node/test-suite.html, queued)
data/        JSON dictionaries / type tables / model tables (built artifacts)
fixture-src/     raw word lists and natural-language texts
tools/       build-time scripts (rebuild dicts from corpora, serve.sh, etc.)
docs/        project docs (start with architecture-overview.md)
```

The 1995-2001 C++ source lives in the sibling [`OG-NiceText-C++`](../OG-NiceText-C++) archive repo.

## Run tests

```sh
npm test            # node --test tests/node/
```

## Run the web UI

The browser-safe core in `js/src/` runs in any modern browser. The
`nicetext.html` page is a static demo: paste/upload text or files,
encode to cover prose, decode back. No build step.

Because ES modules and `fetch()` need a real HTTP origin, serve the
repo over a local web server:

```sh
./tools/serve.sh        # python3 -m http.server on :8888 from repo root
# then open http://localhost:8888/nicetext.html
```

## Run the CLI

```sh
node js/bin/nicetext.js -d data/mit.json -i secret.bin -o cover.txt
node js/bin/scramble.js -d data/mit.json -i cover.txt -o recovered.bin
```

## License

The JavaScript port is MIT-licensed. See [`LICENSE`](LICENSE).

Third-party content bundled in this repository (Project Gutenberg
texts, CMU Pronouncing Dictionary, MIT names list, Moby Project
files, and other corpora) is attributed in [`attributions.html`](attributions.html)
and retains its original licenses.

The original C++ source has its own copyright. See
`nicetext-1.0/COPYRIGHT` in the [`OG-NiceText-C++`](../OG-NiceText-C++) archive repo.
