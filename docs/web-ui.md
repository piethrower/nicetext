# Web UI

Locked-in state of the static web pages, security model, and the
async-engine / progress-modal contract. Companion to:

- `docs/architecture-overview.md`: engine surface
- `docs/architecture-workers.md`: worker pipeline behind the page

## Page map

| Page | Role | Status |
|---|---|---|
| `index.html` | Centered splash, two cards: Fun (any age) / Research (CS student+) | ✅ done |
| `nicetext.html` | The utility, plain-language copy, chip picker, Advanced disclosure. Penny lives in a fixed bottom dock and runs by default (no hash gate). | ✅ utility complete (UX pass landed 2026-04-28; worker enablement landed 2026-04-29) |
| `whats-new.html` | Modern academic paper (~1497 lines): sidebar TOC, nine numbered parts, anchor-linked bibliography. Shipped figures are the a/an-disagreement data table (§6.2), the JS `Map` vs. SAB-BST comparison table (Table 1), and the C++/JS module-surface SVG diagram. | ✅ done |

The home-link pattern (top-left clickable wordmark + speech-bubble SVG) is on every non-index page.

## Current shape (start here)

`nicetext.html` + `css/nicetext.css` + `js/app.js`, static page that
runs the conceal/reveal pipeline entirely in the browser via the worker
jobs API (see `docs/architecture-workers.md`). Imports `./src/index.js`
directly. Run locally with `tools/serve.sh` (python3 http.server on
:8888 from repo root). Static origin is required because `fetch()`
blocks `file://` in modern browsers.

**Top-level layout is four tabs**, one panel rendered at a time inside
fixed shell chrome (navbar + tabs row above, disclaimer footer below):

| Tab id | Panel id | User-facing label | Role |
|---|---|---|---|
| `tab-style` | `panel-style` | Story Style | Pick / build the style that turns a Secret into a cover story |
| `tab-secret` | `panel-secret` | Secrets or Silliness | The payload to conceal (or the revealed result) |
| `tab-cover` | `panel-cover` | The Cover Story | The generated / pasted cover prose |
| `tab-eve` | `panel-eve` | Eve | The Eavesdropper analyzer (see below) |

The default tab on first load is `style`; the active tab persists in the
`nicetext-active-tab` session cookie. The full shell, tab template, and
the Story Style redesign are documented in the current-state sections
that follow ("Tabs + navbar + fixed disclaimer footer", "Story Style tab
redesign"); read those for the load-bearing detail.

**Style selection is not dropdowns.** The Story Style panel uses a
responsive grid of premade **chips** plus a `Premade` / `Custom` / `Pro`
segmented control (`#style-mode-premade` / `-custom` / `-pro`, body class
`style-mode-premade|custom|pro`). Premade shows the chip grid. Custom and
Pro show the Build-Your-Own-Style (BYOS) form, Custom a CSS-scoped
simplified subset, Pro the whole form. There is no standalone
Dictionary / Style-source dropdown pair anymore.

UTF-8 sniff on reveal so binary payloads prompt download / hexdump
instead of garbling the textarea. Custom corpus + custom word list
upload, the in-browser builder, and the genmodel pipeline all ship via
the BYOS form (`js/src/builder/*`, `js/src/grammar/*`).

### Eve tab (`#panel-eve`)

The Eavesdropper tab is a cover-only analyzer surfacing Eve Phase I in
the UI. It is verdict-state driven: `js/app.js` imports
`createVerdictState` / `applyRule` from `js/src/eve/verdict-state.js`,
and Eve runs in a worker (`js/eve-worker.js`, spawned via
`js/src/worker/spawn.js`).

UI level:
- `#eve-go` ("Go") analyzes the cover story currently loaded in **The
  Cover Story** tab. It stays disabled until a cover is loaded (Eve sees
  only the cover, never the secret, the filename, or the chosen style).
- `#eve-slice-size` picks how much of the cover to process (a byte-budget
  preset sliced at the next sentence boundary, or "all").
- `#eve-log` is a narrative, live-region log: per-test progress rows plus
  a per-setting verdict of **likely** / **unlikely** / **unknown** for
  the Story Style parameters Eve infers from the cover alone (no
  descrambling). `#eve-cancel` aborts an in-flight run (routed to the
  worker as a `{type:'cancel'}` message, same as the progress modal).
- `runEveAnalysis()` in `app.js` owns the run: it opens the "Eve is
  running" progress modal, slices the cover, spawns the worker, and
  streams `banner` / `progress` / verdict events into the log.

See `docs/eve-plan.md` for the engine, rule set, and verdict-promotion
semantics.

## Tabs + navbar + fixed disclaimer footer (shipped 2026-05-16, supersedes window-maximize)

The three top-level windows (Style, Secret, Cover Story) became
**tabs** in the same 2026-05-16 day. The earlier maximize/restore
concept (commit `3d55dc8`) is gone, only one panel renders at a
time, always full-viewport between fixed shell chrome.

**Page shell** (top to bottom):
- `header.topbar` (fixed). Logo (wordmark collapses to icon ≤720px),
  three primary action buttons (Build A Style / Conceal A Secret /
  Reveal A Cover Story, buttons collapse to one-word on ≤720px),
  tutorial toggle (always `?` / `×` icon), theme toggle.
- `#navbar-status` (inside `header.topbar`, flex-basis:100% so it
  wraps to its own row). Single global status line that replaced
  the per-panel `#encode-status` / `#decode-status`. Empty by
  default (`display:none`); `.ok` green / `.err` red.
- `nav.tabs` (fixed, below navbar). `Select Style` / `Access Secret`
  / `Review Cover Story` (in that order). Default tab on first load
  = `style`; persists via `nicetext-active-tab` session cookie.
- Active `section.panel[role="tabpanel"]` (fixed, fills the area
  between navbar+tabs and the disclaimer footer). Inactive panels
  `display:none !important`. Tab selection auto-flips after a
  successful Conceal → Cover, Reveal → Secret.
- `footer.disclaimer-footer` (fixed, bottom-most strip, single
  line). `Disclaimer:` is a button that re-opens the agreement
  modal; body text in `<small>` with `text-overflow: ellipsis` on
  narrow viewports.

**Live shell sizing**: `header.topbar` height varies when the
status line wraps. `app.js` runs a ResizeObserver on the navbar +
tabs row that writes `--topbar-h` and `--shell-top` CSS vars; the
tabs row's `top` and the active panel's `inset.top` consume those
vars so layout reflows cleanly. (The grow comes from `#navbar-status`
becoming a second flex row.)

**Standard tab template** (all three panels share these slots):
1. Title (`panel-h2`, sans body) + 2. Subtitle (`panel-subtitle`).
   Both inside `.panel-header` flex row with the per-tab toolbar
   (`.actions`) on the right; toolbar wraps to row 2 on ≤720px.
3. Content Overview (`.panel-meta`, sans body, sticky at top via
   flex-shrink:0). For Secret/Cover: `Text · {origin}` or
   `Binary hexdump format (read-only) · {origin}`. For Style:
   `Style: {chip-or-byos-label}`.
4. Content (slot-4, only scrollable surface per tab via internal
   `overflow:auto`). Secret/Cover: textarea (min-height 200px;
   serif for cover prose, mono for secret hexdump). Style:
   `.tab-content` div wrapping carousel + advanced BYOS form.
5. Content Statistics (`.panel-stats`, sans body, flex-shrink:0
   so it stays at natural height). For Secret/Cover: `N bytes`
   (or `N bytes · SHA-256: {hash}` when non-empty). For Style:
   `#stats-panel` (no card framing, inherits panel bg).
6. Toolbar (`.actions`), lives inside `.panel-header` row 1
   (above slots, not in a fixed footer).

Panel itself is `display: flex; flex-direction: column;
overflow: hidden` so there's no panel-level scrollbar (only
slot 4 scrolls). `--shell-top` keeps the panel anchored
correctly when the navbar grows.

**Build button**: `#adv-build` lives in the navbar (after Reveal,
shared `.topbar-btn` style + `.build-attention` red class for the
dirty state). Always visible; three states (driven by
`updateBuildButton(mode)`):
- Built-in chip or Advanced closed → disabled, no attention.
- BYOS form complete + matches last built / on-disk fixture (clean)
  → disabled.
- BYOS form complete + dirty → enabled, `.build-attention` (red).

**Penny**: dock floats with `bottom: 1.2rem` (clears just the
disclaimer footer). Tutorial open/close handler moved from the
removed `#penny-dock-toggle` to `#topbar-tutorial-toggle` (in
`tutorial-script.js`); `penny.js` bubble × now hits the navbar
toggle directly.

(History: the View modal phase shipped `85178e1`; the maximize
phase shipped `3d55dc8`; this section supersedes both for the
secret/cover/style flow. The View modal infrastructure stays
alive only for the BYOS sub-panels' Custom Corpus + Custom Word
List view buttons.)

## Story Style tab redesign + showPageStatus + tab/title rename (shipped 2026-05-16)

Builds on the tabs/navbar pass above. Three threads:

**Tab + title rename**: the three tabs now read `Story Style`,
`Secrets or Silliness`, `The Cover Story`. Tab IDs (`tab-style`,
`tab-secret`, `tab-cover`) and panel IDs (`panel-style` /
`-secret` / `-cover`) stay the same, only the user-facing labels
+ panel h2 titles changed. The same names are used in
`index.html`'s bit-flow animation rows.

**Subtitles** describe what each tab IS, not how to use it
("Story Style" → "The writing style that turns your secrets or
silliness into cover stories." etc.). The Cover Story subtitle
links the phrases "steganography" and "strong encryption" to
their Wikipedia articles in a new tab.

**Standard `showPageStatus` / `clearPageStatus` API**
(`app.js`). Every action site funnels through one of:
- `showPageStatus(mode, target, result, nextSteps)`: `mode` is
  `'success'` or `'error'`, `target` is the area label (`Style`,
  `Secret`, `Cover story`), `result` is the inline result phrase,
  `nextSteps` is the trailing follow-up sentence. Renders as
  `{target} {result}. {nextSteps}` (success) or
  `{target}: {result}. {nextSteps}` (error).
- `clearPageStatus()`: for in-flight commands like Conceal / Reveal
  where the progress modal carries the in-flight signal. The
  page-status line only fires on terminal outcomes (success / cancel
  / error).
- No more progress strings: modals own progress display.
- `setStatus(el, msg, kind)` still exists for the rare in-modal /
  in-panel sub-status (e.g., `#share-style-status`).

**Story Style internals**:
- Premade / Custom / Pro three-tab segmented control in the panel-
  header (`Premade` default). Session cookie `nicetext-style-mode`
  persists the active tab. Click flips body class
  `style-mode-premade` / `style-mode-custom` / `style-mode-pro`; CSS
  shows the chip grid in Premade and the BYOS form (`.advanced-body`,
  a pre-existing DOM class; Pro is the new name for what was
  originally called "Advanced") in Custom / Pro. Custom is a CSS-
  scoped simplified subset of the same panel (sentence model
  section, emoji-style pillbox, Word Swap rewriter row, Flourishes
  reformatter row, plus the headers above visible rows); Pro shows
  the whole panel. The hidden Custom-mode rows stay in the DOM so
  listeners, presets, and bindings keep working; Pro is just "show
  everything." A Custom-only note ("Full Control emoji settings are
  active. Switch to Pro to edit.") appears under the emoji-style
  pillbox when the active preset is `full-control`; toggled by CSS
  off `body[data-emoji-preset]` (set by `refreshEmojiPresetUI`).
  Click any premade card calls `selectChip`. Click the BYO card
  (still there but no longer rendered; the segmented control
  replaces it entirely).
- Carousel chrome (`#chip-prev` / `#chip-next` / `#chip-dots` /
  `#chip-view-toggle`) removed. Cards always render as a single
  responsive grid (`repeat(auto-fill, minmax(220px, 1fr))`).
- Slot 3 (`#style-meta`) is mode-aware action prompt
  (`Choose one of the premade cards…` / `Casual users: switch to
  Premade…`); the in-Custom version wraps freely.
- Slot 5 stats-panel title carries the identity:
  `Premade Style: {label}` /
  `Custom Style: pending, click Build a Style` /
  `Custom Style: {label}`. The `#stats-panel` no longer renders
  inside a white-card frame.
- BYOS-section header (`Build Your Own Style` h3 + subtitle) and
  blurb paragraph removed, the long explanatory copy lives in
  slot 3 when Custom is active.

**Build button** (`#adv-build`) lives in the navbar after Reveal.
Always visible with three states: disabled when not applicable
(built-in chip or Advanced closed), enabled with red
`.build-attention` when BYOS form is dirty, disabled with no
attention when BYOS form is clean (matches what was last built).
The label is `Build a Style` (referenced consistently in status
messages).

**Disclaimer modal**: clicking the inline `Learn more` link now
clears the agreement cookie so the developer must re-agree on
return. The `Disclaimer:` text in the bottom-fixed footer re-opens
the modal.

**Textarea placeholders**: multi-line guidance, imperative voice,
3-4 lines max with a `*** NiceText is a playful disguise, not
encryption. ***` reminder line. Both Secret + Cover textareas
follow this shape.

## Reveal staging modal (shipped 2026-05-18)

The Reveal pillbox
(`#decode-go`) no longer runs decode directly; it opens
`<dialog id="reveal-modal">`, a staging surface that mirrors the
`#share-modal` two-card chrome (style card + cover card, same
left-border colors). Both cards show a read-only summary of the
currently-selected style and the currently-loaded cover, plus a Load
button that forwards to the existing `#style-file` / `#cover-file`
inputs, the existing change-handler chains own the actual load +
progress + auto-build. The style card also offers an "Open the Story
Style panel" jump that closes the modal and switches the active tab.

Real-time, not staged: Load buttons commit immediately. The modal
just keeps the user on the Reveal flow while they fix what's missing.

A primary `#reveal-modal-go` "Reveal" button at the bottom is gated
iff `coverFullText` is non-empty (style is always selected; no style
gate, no `coverStyleConsistent` gate, the cover deliberately carries
no style fingerprint). When disabled, `#reveal-modal-helper` reads
"Load a cover story to reveal." Click closes the staging modal and
calls `app.js / runReveal()`, which opens the existing "Revealing
secrets…" progress modal and owns the rest of the flow (decode,
Done state, source overwrite confirm, navigate to Secret tab).

Refresh: `app.js / refreshRevealModalState()` reads
`currentSelection.styleLabel`, `coverFullText`, `coverSource`,
`coverLoadedFromFile`. Invoked from `openRevealModal` (on open),
`updateStyleMeta` (style-change broadcast), and `setCoverText`
(deferred via `queueMicrotask` so callers' sync state updates after
`setCoverText` settle first).

Style-load progress: `<label class="file-load">` next to
`#style-download` runs through `app.js / openProgressModal('Loading
story style "…"')` (the Conceal-style phase-headed progress modal).
Phases: Reading file → Decoding embedded corpus → Decoding embedded
word list → Applying to active style. Same modal serves both
`#reveal-style-load` (inside the staging modal) and the Story Style
panel's own Load button.

Probes:
- `tmp/probe-load-style-modal.mjs`: Load Style progress modal.
- `tmp/probe-reveal-modal-step2.mjs`: markup + open/close.
- `tmp/probe-reveal-modal-step3.mjs`: Load button wiring + summaries.
- `tmp/probe-reveal-modal-step4.mjs`: pillbox-opens-modal handoff.
- `tmp/probe-reveal-modal-step5.mjs`: Reveal button gating + runReveal hand-off.

## Custom-corpus/twlist statuses + tutorial refresh + disclaimer copy (shipped 2026-05-17)

Follow-up to the 2026-05-16 Story Style pass:

- **Custom Corpus + Custom Word List** action handlers (Copy / Paste
  / Save / Share / File Load / Clear / View) now route through
  `showPageStatus` with `Custom corpus` / `Custom word list` as
  the target prefix. The in-form `#adv-validation` red row was
  removed entirely (element, CSS, 4 writes, `advBuildErrorMsg`
  stash variable). Build button disabled state + textarea
  placeholders carry the form-state signal, and showPageStatus
  carries action results.
- **Penny's tutorial** (`js/tutorial-script.js`) rewritten step-by-
  step to match the tabs + new names + segmented control + navbar
  Build button. Step 17 (plausible-deniability) explicitly
  disclaims legal advice.
- **Disclaimer copy** in all four HTML files (`nicetext.html`
  modal + footer, `index.html`, `attributions.html`,
  `whats-new.html`) gains `Nothing here is legal advice, talk to
  a real lawyer.` and is re-ordered so that legal disclaimer
  precedes the don't-cause-harm / use-at-own-risk lines.
- **Tutorial toggle** in the navbar now always renders a single
  `?` glyph; open vs closed state is conveyed by a filled-blue
  vs outline-only background (no `×` glyph anymore).
- **Hacker-mode text** for navbar Conceal / Reveal trimmed:
  `encode` / `decode` instead of `encode >>` / `<< decode`.
- **Reveal auto-switches** to Secrets or Silliness on all three
  success paths (overwrite-applied, already-matches, overwrite-
  cancelled) so Penny's tutorial promise of the tab flipping is
  consistently honored.
- **Placeholders**: multi-line, imperative; both Secret + Cover
  textareas end with the `*** NiceText is a playful disguise, not
  encryption. ***` warning line.
- **Inline `onload` in `index.html`** for the Penny SVG was being
  blocked by the page CSP. Replaced by a DOMContentLoaded-deferred
  listener in `js/bit-flow.js` (`img.penny-figure-img`). Same fade-
  in-when-loaded effect.
- **Disclaimer "Learn more"** in the agreement modal clears the
  agreement cookie so departure counts as explicit disagreement.

## Locked-in `nicetext.html` state (reference, don't re-derive)

A multi-step interactive pass with the developer landed on
2026-04-28. The shape of the page settled at:

**Lingo (locked in)**
- "Your Secret" / "The Cover Story" are the two panels. Each H2
  carries a small subtitle (`<small class="panel-subtitle">`):
  "what you will smuggle to your friend" / "friendly smuggling, not
  encryption". Don't reintroduce "what to hide" / "cover text" /
  "nicetext" branding into the panels.
- Action verbs on the primary buttons are **Conceal** / **Reveal**
  (single word, no `&nbsp;`). "Smuggle" survives only as branding,
  page tagline ("Smuggle a message inside a story; reveal it later"),
  Penny's tutorial voice, the index-page wordmark "smuggle a secret,
  hope nobody notices", never as a button label.
- The dictionary is the **Decoder Dictionary** in user-facing copy.
  Don't say "word list" anywhere visible (the OG attribution line
  "Numeric word lists" stays).
- Story style is "the recipe for what kind of story to write"; only
  used when hiding.
- The randoms control is a [Random] button + size-in-characters input
  group. Don't re-introduce verbose prefix labels.

**Layout (locked in)**
- Each panel is a 3-column CSS grid (`1fr auto 1fr`). The H2 sits in
  the centered `auto` column; the primary button (Conceal / Reveal)
  sits in a flanking 1fr column at the inner edge so the two
  buttons hug the panel boundary across the page. Status row spans
  the full panel below the H2; stats row sits between the textarea
  and the toolbar. Both reserve min-height so showing/clearing text
  never shifts the toolbar or scrolls the page.
- Toolbars use `flex-wrap: nowrap` with horizontal overflow as a
  fallback, and at 1200 px landscape no horizontal scrolling
  triggers because all stats moved out of the toolbar.
- Primary buttons are single-word (Conceal / Reveal); no `&nbsp;`
  needed. Each panel pairs the button with a directional arrow
  (horizontal in landscape, vertical in portrait) so the button
  always points at the other panel.

**Chips**
- Chip carousel default; tiles view via a small grid icon next to
  the centered dot indicator. CSS grid `repeat(auto-fill, minmax(220px, 1fr))`
  in tiles mode keeps card widths uniform across rows.
- Chip order is alphabetical by label. Includes a "Names and Places"
  chip that pairs the mit dict with `grammar:mit-names`.

**Advanced (Build Your Own Style)**
- Inline disclosure under the cards section, between the chip
  carousel `<section class="panel">` and the stats-panel section.
  Toggled by the `Advanced` button in the bottom-right of
  `.chip-controls-row` (uses `.about-toggle` for parity with
  Introduction / Historical Notes) and by the BYOS chip in the
  carousel; both call `openAdvancedModal()` which flips
  `#advanced-body[hidden]`. Collapse purges the custom-corpus and
  custom-twlist uploads so secrets-adjacent state doesn't outlive
  the open panel (rule 27 spirit; storage layer untouched either way).
- Header mirrors the Your Secret / The Cover Story panels:
  `panel-h2` "Build Your Own Style" + `panel-subtitle` "for when no
  card above fits". Subtitle carries an `(i)` info-btn that toggles
  the advisory blurb ("Casual users: pick a card above and ignore
  this panel...").
- Form order: Story Style → (Custom corpus upload row + info-body,
  visible only when `Custom (upload a corpus)` picked) → Sentence
  Scope + Vocabulary Scope grid → Base Dictionary fieldset (with
  Custom TW-list upload nested) → Word Frequencies fieldset →
  Prefer-shorter-words tiebreak → centered Build button.
- Story Style sits in its own 2-column grid so its dropdown column
  matches the Sentence/Vocabulary grid below at all widths.
- Build button is `.primary big` with a static `↓` (matches the
  Conceal/Reveal idiom; no h/v swap since it always points at the
  stats panel below). Label is in `<span id="adv-build-label">` so
  it can flip to "Build Complete" without disturbing the arrow.
- Build-complete state: panel does NOT auto-close on success.
  `advBuildComplete` flag → button reads "Build Complete ↓" disabled
  until any panel change (delegated `input`+`change` on
  `#advanced-body` plus explicit clears in the two Clear-button
  click handlers) flips it back to "Build ↓" enabled (subject to
  validation).

**Penny**
- Always loads on `nicetext.html` (no `#tutorial` hash gate). She
  lives in a fixed bottom dock with reserved body padding-bottom so
  she never overlaps real content. The dock has two states:
  - Expanded: a small × button in the top-right corner.
  - Collapsed: the whole strip becomes a clickable bar reading
    "Open Tutorial ▾". `tutorial-script.js`'s `setCollapsed`
    delays `startPenny()` 220 ms when un-collapsing so the
    snap-to-line bubble measurement uses the post-transition dock
    height (not the still-shrunk transitional height).
- `penny.js` does word-by-word typewriter reveal (35 ms base, longer
  pauses after sentence punctuation). `_snapBubbleHeight` snaps the
  bubble cap to a whole-line boundary on overflow; CSS gradient
  fade hint via `.penny-has-overflow`. Click anywhere outside
  next/skip/restart to skip the typewriter.
- Tutorial: 14 steps. The first 9 walk the basics; steps 10-14 are
  the Advanced-tab walkthrough (Story style + Decoder Dictionary +
  the punchline that only the dictionary matters for recovery).
  Final-step button is a `.penny-restart` that re-runs `runStep(0)`,
  not a `.penny-skip` that dismisses.
- Penny's color is the page accent blue (`#2b6cb0` / `var(--accent)`)
  not the Span-It! brown.

**Bottom-bar + footer**
- Disclaimer (left) and Historical Notes toggle (right) share one
  row: `flex-wrap: nowrap; align-items: flex-start`; toggle is
  `flex-shrink: 0; white-space: nowrap` so it never wraps to its
  own line. Disclaimer text wraps internally as the viewport
  narrows.
- The github-source / "museum piece" footer is gone; replaced by
  the disclaimer.

**Probes / scratch**
- `tmp/probe-*.mjs` files are Playwright (via `playwright-core`)
  probes used to validate landscape alignment, dock states, button
  positions, and typewriter reveal. They're throwaway-but-keep.
- Run `tools/serve.sh` (port 8888) before any probe.

## Engine yield + onProgress contract (design, locked in)

`encode()` and `decode()` are both `async`. They take an optional
`opts.onProgress` callback, and on a fixed cadence (every 64 models
in encode; every 64 word tokens in decode) they:

1. If `onProgress` is set, `await onProgress({ ... })`. Returning
   `'cancel'` (sync or promise) makes the engine throw an Error with
   `.code = 'cancelled'`.
2. **Always** `await new Promise(r => setTimeout(r, 0))`,
   regardless of whether anyone supplied `onProgress`.

The unconditional yield is the load-bearing decision. Without it a
sync hot loop is rude in two environments at once: the browser main
thread freezes (no repaints, no Cancel clicks), and Node stalls
SIGINT (Ctrl-C only lands when the loop unblocks), holds back
stdout flushes, and starves any other async work in the process.
The `setTimeout(0)` (≈4 ms in browser, sub-ms in Node)
pays a tiny throughput cost for well-behaved engines everywhere.

After the worker arc, the engine still yields the same way, but
encode/decode normally run in worker threads, the yield in the worker
thread doesn't block the page main thread. The contract stays
load-bearing for inline callers (CLI, tests, programmatic use) where
no worker is involved.

Progress payloads:
- Encode: `{ bytesConsumed, totalBytes, modelsProcessed }`. Note
  `bytesConsumed` is computed via `(initialBytesRemaining -
  reader.bytesRemaining) / initialBytesRemaining * payload.length`
  rounded and clamped, **not** the naive
  `payload.length - reader.bytesRemaining` from the original plan
  (which goes negative because escapes + EOF marker make
  `bytesRemaining` start larger than `payload.length`).
- Decode: `{ wordsProcessed, totalWords }`. `totalWords` is known
  up-front because decode now uses `tokenizeArray()` rather than the
  streaming `tokenize()` generator.

Browser-side modal driver in `app.js / openProgressModal`: opens the
`<dialog id="progress-modal">` after a 300 ms grace period so fast
operations never flash it. Cancel clicks invoke
`AbortController.abort()`; the worker jobs API (`encodeJob` /
`decodeJob`) plumbs the resulting `AbortSignal` through to the
in-flight worker as a `{type:'cancel'}` message. Cancelled errors
are surfaced via `friendlyError()` as "Cancelled." without
`console.error` noise.

The modal also shows a small italic memory-mode line
(`#progress-modal-mode`) below the bar:

- "Workers share memory (SAB)." when `window.crossOriginIsolated`
  and `SharedArrayBuffer` is available.
- "Workers use per-job copies (ArrayBuffer fallback)." otherwise.

It's set once on modal open (not updated mid-job; the value is
stable for the page lifetime). End users who notice it can correlate
slowness with the fallback path; most users will skim past it. See
`docs/architecture-sab.md` for the GH-Pages COOP/COEP situation
that drives the two modes.

Ingress-side modals (no engine, just I/O + DOM):
- BYOS Custom Corpus (`verifyAndPrecleanCustomCorpus`): preclean runs
  in `js/src/worker/preclean-worker.js`; the worker posts a `progress`
  message after each rule completes and the main thread surfaces it
  in the modal. `precleanCorpusAsync({ signal, onProgress })` honours
  the modal's `AbortSignal`, on cancel the worker is terminated and
  the next call respawns it. See `docs/pre-cleaning-corpus-rules.md`.
- BYOS Custom Word List (`verifyAndCommentCustomTwlist`): parse runs
  on the main thread, but the modal opens *before* the synchronous
  textarea write and each stage (load → split → parse → rewrite →
  display → hash) yields rAF and short-circuits on
  `modal.signal.aborted`. File-load path passes raw text via arg
  instead of pre-writing the textarea, that DOM op is the Safari
  pain point and now happens inside the modal contract.
- Your Secret / Your Cover Story loadbox path
  (`loadSourceFromFileWithModal` / `loadCoverFromFileWithModal`):
  used only when the file exceeds `T_SECRET_BYTES` /
  `T_COVER_BYTES` and the user picks "Load into box" from the
  pipeline-consent dialog. Per-stage progress (read → detect →
  decode/unwrap → display) with rAF yields and signal honoured.
  Below-threshold fast path is unchanged, no modal flash for small
  files.

The page also loads `js/coi.js` from `<head>` before any other
script. That helper detects whether the page is cross-origin
isolated, registers `coi-sw.js` if not, and reloads once on first
visit so the Service Worker can intercept the page's own load and
add COOP/COEP headers. On `tools/serve.py` the headers are already
set server-side and the SW registers but no reload is needed; on
plain `python3 -m http.server` or GitHub Pages, first visit reloads
once. The console.info messages from `coi.js` are prefixed `[coi]`
and grep-able if a developer wants to confirm which mode the page
is running in.

## History appendix (superseded / changelog)

The sections below are kept for archaeology only: they describe states
that later sections supersede, or are commit-by-commit changelogs of how
the page reached its current shape. Nothing here is the current
reference. Read the current-state sections above instead.

### Toolbar + View modal + security pass (shipped 2026-04-29)

Sequence of small commits that future sessions shouldn't redo:

- **Smuggle / Unpack rename** (`2a84026`). All user-facing copy on
  `nicetext.html` now uses the smuggling metaphor: button labels
  `Smuggle it` / `Unpack it`, status messages `Smuggled! ✓` /
  `Unpacked! ✓`, page title and tagline match `index.html`'s
  *"smuggle a secret, hope nobody notices"*. Tutorial text in
  `js/tutorial-script.js` rewritten to match.
- **Repo restructure to Span-It! conventions** (`9bc9db6`).
  `web/` is gone: HTML pages live at the root,
  `css/`, `img/`, `js/` are top-level dirs, tests live under
  `tests/node/`. `npm test` runs `node tests/node/run-node.mjs`.
- **Browser-side test runner** (`a54c682`). `tests/node/test-suite.html`
  + `harness.js` + `manifest.json` + shims in
  `tests/node/shims/` (node-test, node-assert, node-fs). Same
  76 tests pass via `node --test` and via the page. Linked from
  `index.html`'s Research card. See
  `docs/test-infrastructure.md`.
- **Story textarea serif font** (`e3d5f08`). `#cover-text` reads
  in `"Iowan Old Style", "Charter", Georgia, Cambria, serif` at
  0.95rem / 1.55 line-height. Secret stays monospace via
  `var(--font-mono)`. Per-style theming (Aesop ↔ Magical ↔
  Tasting drop-caps) parked: there's no reliable way to recover
  the chosen style from a saved-and-reloaded story without
  embedding metadata or making the user re-pick. ROE rule 26
  forbids embedding markup in cover text anyway.
- **Security pass: CSP + Trusted Types** (`9e4fd6e`).
  `nicetext.html` ships with a strict CSP `<meta>`:
  `default-src 'self'; script-src 'self'; style-src 'self';`
  `img-src 'self'; font-src 'self'; connect-src 'self';`
  `object-src 'none'; base-uri 'self'; form-action 'self';`
  `require-trusted-types-for 'script'`. All `el.innerHTML = ''`
  clearings rewritten to `el.replaceChildren()`. Penny tutorial
  registers a passthrough TrustedTypePolicy named
  `'penny-tutorial'` for its hand-authored step HTML; the
  worker shim (added 2026-04-29) registers
  `'engine-worker-url'` for the Worker constructor's
  TrustedScriptURL requirement. Everywhere else, innerHTML throws
  at runtime. Two cross-cutting invariants:
  - **User-supplied content never enters the DOM as markup**:
    textContent / createTextNode / `<textarea>.value` only.
    CSP+Trusted Types enforces it.
  - **No persistence of secrets or generated stories**
    (no cookies, localStorage, sessionStorage, IndexedDB, Cache).
    Form fields touching secrets carry
    `autocomplete="off" autocorrect="off" autocapitalize="off"
    spellcheck="false"`.
  - Old "Plans are not build plans" renumbered to **Rule 28**.
- **Panel toolbars + View modal** (`85178e1`). Renames
  Erase→Clear, Open→Load. Story toolbar reordered to
  `Copy · Paste · Load · Save · Clear · View` (Edit-menu
  convention). Secret toolbar `Load · Make · Save · Clear · View`.
  New shared View modal (`<dialog id="view-modal">`):
  story view in serif, secret text in mono, secret binary as
  classic 16-byte-per-row hexdump (`formatHexdump` in `js/app.js`).
  Body is a readonly `<textarea>` so attacker-supplied content
  from a hostile paste never reparses as markup; CSP+Trusted
  Types is the runtime backstop.
- **Toolbar redesign: stacked icons + Make popover + centered**
  (`17f380b`). Toolbar buttons are now icon-above-label
  (macOS-toolbar style); the always-visible label kills the
  earlier breakpoint logic. Make is a popover trigger
  (`<button popovertarget>`) opening a small native
  `<div popover id="make-popover">` with the byte-size input +
  Make/Cancel; light-dismiss and Esc are native. Both toolbars
  centered under their panel at every viewport.
- **UI polish: panel theming, Conceal/Reveal verbs, subtitles,
  Share placeholder, View modal button-borrow** (commit
  forthcoming, 2026-04-29).
  - Secret/Story panels themed: secret bg `#f3efe6` (warm),
    cover bg `#eef2f6` (cool), 2px border in `#b9b9b3`. Lifts
    each panel off the page bg so they read as containers.
  - H2 size bumped to `1.7rem` on the secret/story panels, with
    a 0.85rem `<small class="panel-subtitle">` below in
    `var(--muted)`.
  - "The Story" → "The Cover Story" everywhere it names the
    panel; lowercase "story" in narrative copy still refers to
    the literary thing.
  - Smuggle/Unpack → **Conceal/Reveal** rename across button
    labels, status messages, modal titles, placeholders, Penny's
    tutorial wherever she references a button by name. "Smuggle"
    survives only as branding (tagline, Penny narrative voice,
    index wordmark). Trailing "it" dropped from button labels,
    they're single-word now.
  - **Share** button (disabled placeholder, "Share: coming
    soon" tooltip) sits first in the cover toolbar before Copy.
  - View modal **borrows** live panel-toolbar buttons rather
    than duplicating: on open, `app.js / viewBorrowButtons`
    moves Share/Copy/Save (cover) or Save (secret) into a slot
    in the modal header; on close (Esc, X, or programmatic),
    the dialog's `'close'` listener returns each to its original
    parent + nextSibling. Single set of event handlers, no
    duplicate state.
  - View modal titles read "Viewing The Cover Story" / "Viewing
    The Secret (N bytes, text|binary hexdump)".

### Window maximize + above/below meta strips (shipped 2026-05-16, superseded)

The three top-level panels. Your Style, Your Secret, Your Cover Story
, each got a Maximize/Restore button replacing the old View button. The
View modal infrastructure stays for the Advanced sub-panels (custom
corpus + custom word list); source/cover branches removed.

**Maximize mechanism** (`css/nicetext.css`, `app.js / setMaximize`):
body class `maxstyle` / `maxsecret` / `maxcover` (mutually exclusive)
hides the other two panels via `display:none` and pins the maximized
panel to the viewport (`position:fixed; inset:0; z-index:1;
grid-template-rows: ... 1fr ...` so the textarea row absorbs extra
vertical space). Penny stays overlaid (z-index:2). A `.max-only` class
hides controls in the restored state; CSS reveals them when the
parent panel is maximized.

**Max-only action buttons** (so encode/decode are reachable without
restoring):
- Your Secret max: new `#source-reveal` button in the actions row
  delegates to `#decode-go`.
- Your Cover Story max: existing `#cover-encode` (Conceal) carries
  `.max-only`; the previously dead `#view-modal-actions-slot #cover-encode`
  CSS rule is gone.

**Meta strip above each textarea** (`#source-meta`, `#cover-meta`,
new `.panel-meta` CSS class in the panel grid). Describes the
type/source of the current content; replaces today's metadata-embedded-
in-textarea binary placeholder. Labels are sentence case:
- Source: `No secret loaded` / `Text · {origin}` /
  `Binary hexdump format (read-only) · {origin}`. Origins:
  `loaded from {filename}` / `pasted` / `typed` / `revealed from cover` /
  `random {N} bytes ({format})`.
- Cover: `No cover story loaded` / `Concealed` / `Pasted` / `Loaded` /
  `Loaded from {filename}`.

`loadedSource` / `coverSource` enums track the origin; a one-shot
`pendingPasteFlip` / `coverPendingPasteFlip` flag (set in `paste`
event, read+cleared in `input`) distinguishes paste from typed.

**Stats strip below each textarea** (`#source-stats`, `#cover-stats`):
- Source: `0 bytes` when empty; `{N} bytes · SHA-256: {hash}`
  otherwise. CSS `text-overflow: ellipsis` truncates the line on
  narrow screens.
- Cover: `0 bytes` when empty; `{N} bytes` for pasted/loaded;
  `{N} bytes · story is {ratio}× bigger than the secret` after a
  successful Conceal. Bytes are true UTF-8 byte count via
  TextEncoder. Ratio formatter in `app.js / formatRatio`: `>100`
  rounds to integer; `>10` shows 1 decimal; `≤10` shows 2 decimals.

**Binary hexdump rendering** (`app.js / renderSourceTextarea`): binary
content lands as `formatHexdump(bytes)` in the source textarea with
`wrap='off'` (horizontal scroll on narrow screens; rows MUST NOT
wrap because the offset/hex/ascii alignment becomes unreadable).
Text content uses default `wrap='soft'`.

### Browser-side feedback features (shipped 2026-04-28)

The three-phase plan landed:

- **Phase 1** (commit `5917a2c`, superseded 2026-05-18 by the Reveal
  staging modal below), formerly the Reveal pillbox disabled when
  zero dict-matching words appeared in the cover. The pillbox is now
  permanently enabled; gating moved into `#reveal-modal-go` (cover
  non-empty only). `app.js / refreshDecodeButton` survives as a
  dict-prefetch hook only. The original probe
  `tmp/probe-decode-disable.mjs` exercises the old gating and no
  longer reflects current behavior; kept as historical reference.
- **Phase 2** (commit `2c8d050`): SHA256 compare of recovered vs.
  current source. Equal: "already matches your current secret", no
  replace. Differs + non-empty source: native `<dialog
  id="overwrite-confirm">` with Replace / Cancel. Empty source:
  silent replace. Probe: `tmp/probe-overwrite-prompt.mjs`.
- **Phase 3**: Engine async + `onProgress` + yield; browser progress
  modal + Cancel. The 2026-04-29 worker arc later replaced the
  inline-on-main encode/decode path with worker dispatch via
  `encodeJob` / `decodeJob` (`docs/architecture-workers.md`); the
  modal contract below is the cancellation surface for both.
  Probe: `tmp/probe-progress-modal.mjs`.
