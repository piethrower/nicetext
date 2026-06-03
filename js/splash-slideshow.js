// Splash-page slideshow boot. Mounts the 11-slide narrative into
// #slideshow-mount using a rigid 3-row x 3-col grid (watcher /
// alice-message-bob / caption). Slots are permanent, empty when
// unused: so layout never shifts as slides advance.

import { Slideshow } from './slideshow.js';
import { mountNiceTextAnim, mountStaticPhase, mountPhaseAnim, mountNarratedAnim } from './bit-flow.js';
import { svgNoteCard, svgProhibitStamp } from './svg.js';

// ---- SVG inline injection ----
// <img src="x.svg"> renders the SVG in its own context, so
// currentColor falls back to the SVG's default (black) instead of
// inheriting the page's theme color. Fetching the SVG text, parsing
// it as DOM, and cloning the result into the slide DOM means
// currentColor resolves against the surrounding theme. Cached per
// path so each slide render is a synchronous clone.

const svgCache = new Map();

// Trusted Types policy so DOMParser.parseFromString accepts our SVG
// strings under `require-trusted-types-for 'script'`. The SVGs are
// same-origin files we author; this passthrough is the "we trust
// this string" gate the CSP requires.
const svgTrust = (typeof window !== 'undefined' && window.trustedTypes)
  ? window.trustedTypes.createPolicy('splash-svg', { createHTML: (s) => s })
  : null;

async function preloadSvg(path) {
  if (svgCache.has(path)) return;
  const res = await fetch(path);
  if (!res.ok) throw new Error(`failed to fetch ${path}: ${res.status}`);
  const text = await res.text();
  const html = svgTrust ? svgTrust.createHTML(text) : text;
  const doc = new DOMParser().parseFromString(html, 'image/svg+xml');
  svgCache.set(path, doc.documentElement);
}

function inlineSvg(path, ariaLabel) {
  const cached = svgCache.get(path);
  if (!cached) throw new Error(`svg not preloaded: ${path}`);
  const svg = cached.cloneNode(true);
  // SVG's intrinsic width/height attributes (80 / 115) would
  // otherwise lock the rendered size; strip so the CSS can drive
  // sizing via `height: var(--char-h)`.
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  if (ariaLabel) svg.setAttribute('aria-label', ariaLabel);
  return svg;
}

// ---- Content helpers (each returns a DOM node, never appends) ----

function el(tag, className, content) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (content != null) n.textContent = content;
  return n;
}

function charFigure(src, label) {
  // The character name is baked into the SVG itself, no separate
  // figcaption needed. The <figure> wrapper stays so semantic markup
  // is preserved; the SVG carries its own <title> + an aria-label
  // for accessibility.
  const fig = document.createElement('figure');
  fig.appendChild(inlineSvg(src, label));
  return fig;
}

// Character block for an alice/bob slot: just the figure. The
// character's key, when held, goes into a separate slot (slot-
// alicekey / slot-bobkey) in row 3, pinned out of Eve's row-1
// sight without shifting the character's position in row 2.
function charBlock(src, label) {
  const block = el('div', 'character-block');
  block.appendChild(charFigure(src, label));
  return block;
}

function keyIcon() {
  const k = el('span', 'character-key', '🔑');
  k.setAttribute('aria-hidden', 'true');
  return k;
}

// Eve in the watcher slot (row 1). Optional prop emoji beside her.
function watcherEve(prop) {
  const block = el('div', 'watcher-block');
  block.appendChild(charFigure('img/eve.svg', 'Eve'));
  if (prop) {
    const p = el('span', 'watcher-prop', prop);
    p.setAttribute('aria-hidden', 'true');
    block.appendChild(p);
  }
  return block;
}

// Wrap a message-slot node in an animated chevron strip below the
// message. Chevrons pulse left-to-right to suggest the payload is
// in transit from Alice to Bob. Use for transit-mode message
// slots; skip for static modes (CTA, secret-meeting, etc.).
function chevrons() {
  const wrap = el('div', 'scene-chevrons');
  for (let i = 0; i < 12; i++) wrap.appendChild(el('span', 'scene-chevron', '›'));
  return wrap;
}
function flowing(messageNode) {
  const wrap = el('div', 'scene-channel-flow');
  wrap.appendChild(messageNode);
  wrap.appendChild(chevrons());
  return wrap;
}

// Stack any number of card nodes vertically in a flex column. Each
// child claims an equal share of the stack height via the CSS rule
// on .scene-message-stack > .note-card (flex: 1 1 0; min-height: 0).
// Used by slides that show a transform pipeline (e.g. Message →
// transform-card → Secret) as well as multi-cover-story stacks.
function messageStack(...cards) {
  const stack = el('div', 'scene-message-stack');
  for (const c of cards) stack.appendChild(c);
  return stack;
}

function keyIconBig() {
  const k = el('span', 'scene-key', '🔑');
  k.setAttribute('aria-hidden', 'true');
  return k;
}

function caption(text, extraClass) {
  const p = el('p', 'scene-caption', text);
  if (extraClass) p.classList.add(extraClass);
  return p;
}

// ---- Slot assembly ----
// Every slide produces 5 slot elements via buildSlide. Wide mode
// (slide 11) replaces alice/bob slots with a full-width message
// slot via the slot-message-wide class.

function slot(className, content) {
  const s = el('div', className);
  if (content) s.appendChild(content);
  return s;
}

// ---- Mode-specific slide builders ----
// Each builder knows which slots its mode template expects. The
// caller (slide render) passes only the relevant content per mode.

function buildTransit(root, { eve, alice, aliceKey, aliceWork, message, bob, bobKey, bobWork, caption: cap }) {
  root.appendChild(slot('slot-watcher', eve));
  root.appendChild(slot('slot-alice', alice));
  root.appendChild(slot('slot-message', message));
  root.appendChild(slot('slot-bob', bob));
  root.appendChild(slot('slot-alicekey', aliceKey));
  root.appendChild(slot('slot-bobkey', bobKey));
  root.appendChild(slot('slot-alicework', aliceWork));
  root.appendChild(slot('slot-bobwork', bobWork));
  root.appendChild(slot('slot-caption', cap));
}

function buildSoloAlice(root, { alice, work, caption: cap }) {
  root.appendChild(slot('slot-alicework', work));
  root.appendChild(slot('slot-alice', alice));
  root.appendChild(slot('slot-caption', cap));
}

function buildSoloBob(root, { bob, work, caption: cap }) {
  root.appendChild(slot('slot-bob', bob));
  root.appendChild(slot('slot-bobwork', work));
  root.appendChild(slot('slot-caption', cap));
}

function buildDuo(root, { alice, bob, sharedKey, caption: cap }) {
  root.appendChild(slot('slot-alice', alice));
  root.appendChild(slot('slot-sharedkey', sharedKey));
  root.appendChild(slot('slot-bob', bob));
  root.appendChild(slot('slot-caption', cap));
}

function buildCta(root, { cta, caption: cap }) {
  root.appendChild(slot('slot-cta', cta));
  if (cap) root.appendChild(slot('slot-caption', cap));
}

// ---- Slide definitions ----

const ENCRYPTED = '1010110011';

const slides = [
  {
    id: 'intro',
    chapter: 'Strong Encryption 101',
    mode: 'transit',
    durationMs: 6000,
    render: (root) => buildTransit(root, {
      alice:   charBlock('img/alice.svg', 'Alice'),
      message: flowing(svgNoteCard({ label: 'Message:', body: 'Snowball attack at dawn' })),
      bob:     charBlock('img/bob.svg', 'Bob'),
      caption: caption('Alice wants to send Bob a private message.'),
    }),
  },
  {
    id: 'eve-watching',
    chapter: 'Strong Encryption 101',
    mode: 'transit',
    durationMs: 5000,
    render: (root) => buildTransit(root, {
      eve:     watcherEve(),
      alice:   charBlock('img/alice.svg', 'Alice'),
      message: flowing(svgNoteCard({ label: 'Message:', body: 'Snowball attack at dawn' })),
      bob:     charBlock('img/bob.svg', 'Bob'),
      caption: caption('But Eve is watching.'),
    }),
  },
  {
    id: 'password-exchange',
    chapter: 'Strong Encryption 101',
    mode: 'duo',
    durationMs: 6000,
    render: (root) => buildDuo(root, {
      alice:     charBlock('img/alice.svg', 'Alice'),
      sharedKey: keyIconBig(),
      bob:       charBlock('img/bob.svg', 'Bob'),
      caption:   caption('So Alice and Bob meet secretly to agree on a password.'),
    }),
  },
  {
    id: 'encrypt',
    chapter: 'Strong Encryption 101',
    mode: 'solo-alice',
    durationMs: 6500,
    render: (root) => buildSoloAlice(root, {
      alice: charBlock('img/alice.svg', 'Alice'),
      work:  messageStack(
        svgNoteCard({ label: 'Message:', body: 'Snowball attack at dawn' }),
        svgNoteCard({ label: 'encrypt with password 🔑' }),
        svgNoteCard({ label: 'Secret:', body: ENCRYPTED, encrypted: true }),
      ),
      caption: caption('Alice encrypts the message with the password.'),
    }),
  },
  {
    id: 'send-encrypted',
    chapter: 'Strong Encryption 101',
    mode: 'transit',
    durationMs: 6000,
    render: (root) => buildTransit(root, {
      eve:      watcherEve(),
      alice:    charBlock('img/alice.svg', 'Alice'),
      message:  flowing(svgNoteCard({ label: 'Secret:', body: ENCRYPTED, encrypted: true })),
      bob:      charBlock('img/bob.svg', 'Bob'),
      aliceKey: keyIcon(),
      bobKey:   keyIcon(),
      caption:  caption('Alice sends Bob the encrypted message.'),
    }),
  },
  {
    id: 'bob-decrypts',
    chapter: 'Strong Encryption 101',
    mode: 'solo-bob',
    durationMs: 6500,
    render: (root) => buildSoloBob(root, {
      bob:     charBlock('img/bob.svg', 'Bob'),
      work:    messageStack(
        svgNoteCard({ label: 'Secret:', body: ENCRYPTED, encrypted: true }),
        svgNoteCard({ label: 'decrypt with password 🔑' }),
        svgNoteCard({ label: 'Message:', body: 'Snowball attack at dawn' }),
      ),
      caption: caption('Bob uses the same password to decrypt and read it.'),
    }),
  },
  {
    id: 'eve-cant-decrypt',
    chapter: 'Strong Encryption 101',
    mode: 'solo-bob',
    durationMs: 7000,
    render: (root) => buildSoloBob(root, {
      bob:  charBlock('img/eve.svg', 'Eve'),
      work: messageStack(
        svgNoteCard({ label: 'Secret:', body: ENCRYPTED, encrypted: true }),
        svgNoteCard({ body: '?? random junk ??' }),
      ),
      caption: caption("Eve can't decrypt. Without the password, it looks like random junk."),
    }),
  },
  {
    id: 'eve-blocks',
    chapter: 'When Strong Encryption Gets Blocked',
    mode: 'transit',
    durationMs: 6000,
    render: (root) => {
      buildTransit(root, {
        eve:     watcherEve(),
        alice:   charBlock('img/alice.svg', 'Alice'),
        message: flowing(svgNoteCard({ label: 'Secret:', body: ENCRYPTED, encrypted: true })),
        bob:     charBlock('img/bob.svg', 'Bob'),
        caption: caption('Eve says anything that looks like random junk is prohibited.'),
      });
      // Stamp the prohibit overlay across the entire message slot,
      // sits above the note + chevrons via z-index, sized by CSS
      // (inset: 0), not hard-coded coords.
      const slot = root.querySelector('.slot-message');
      if (slot) slot.appendChild(svgProhibitStamp());
    },
  },
  {
    id: 'alice-motivation',
    chapter: 'When Strong Encryption Gets Blocked',
    mode: 'solo-alice',
    durationMs: 6500,
    render: (root) => buildSoloAlice(root, {
      alice: charBlock('img/alice.svg', 'Alice'),
      work:  svgNoteCard({ label: 'Secret:', body: ENCRYPTED, encrypted: true }),
      caption: caption('Alice wants a way to make her encrypted bits look harmless.'),
    }),
  },
  {
    id: 'nicetext-conceal',
    chapter: 'Introducing NiceText',
    mode: 'solo-alice',
    durationMs: 8000,
    render: (root) => {
      const workSlot = el('div', 'slide-nicetext-anim-slot');
      buildSoloAlice(root, {
        alice: charBlock('img/alice.svg', 'Alice'),
        work:  workSlot,
        caption: caption('Alice uses NiceText to conceal her secret as a cover story.'),
      });
      const handle = mountPhaseAnim(workSlot, 'conceal');
      return () => handle.stop();
    },
  },
  {
    id: 'share-style',
    chapter: 'Introducing NiceText',
    mode: 'duo',
    durationMs: 6000,
    render: (root) => {
      const styleSlot = el('div', 'slide-nicetext-anim-slot');
      buildDuo(root, {
        alice:     charBlock('img/alice.svg', 'Alice'),
        sharedKey: styleSlot,
        bob:       charBlock('img/bob.svg', 'Bob'),
        caption:   caption('Alice secretly shares the style with Bob.'),
      });
      const handle = mountPhaseAnim(styleSlot, 'share-style');
      return () => handle.stop();
    },
  },
  {
    id: 'share-cover',
    chapter: 'Introducing NiceText',
    mode: 'transit',
    durationMs: 6500,
    render: (root) => {
      const coverSlot = el('div', 'slide-nicetext-anim-slot');
      buildTransit(root, {
        eve:     watcherEve(),
        alice:   charBlock('img/alice.svg', 'Alice'),
        message: flowing(coverSlot),
        bob:     charBlock('img/bob.svg', 'Bob'),
        caption: caption('Alice sends Bob the cover story. Eve does not catch on right away.'),
      });
      const handle = mountPhaseAnim(coverSlot, 'share-cover');
      return () => handle.stop();
    },
  },
  {
    id: 'bob-reveals',
    chapter: 'Introducing NiceText',
    mode: 'solo-bob',
    durationMs: 8000,
    render: (root) => {
      const workSlot = el('div', 'slide-nicetext-anim-slot');
      buildSoloBob(root, {
        bob:  charBlock('img/bob.svg', 'Bob'),
        work: workSlot,
        caption: caption('Bob reveals the encrypted bits using the style Alice shared.'),
      });
      const handle = mountPhaseAnim(workSlot, 'reveal');
      return () => handle.stop();
    },
  },
  {
    id: 'alice-entertainment',
    chapter: 'Introducing NiceText',
    mode: 'transit',
    durationMs: 7000,
    render: (root) => {
      // Multi-cover stack in the message slot suggests Alice has
      // been sending lots of these.
      const stack = messageStack(
        svgNoteCard({ label: 'Cover Story:', body: 'Once upon a time...' }),
        svgNoteCard({ label: 'Cover Story:', body: 'Hark, a voice rises...' }),
        svgNoteCard({ label: 'Cover Story:', body: 'My friends, the time...' }),
      );
      buildTransit(root, {
        eve:     watcherEve(),
        alice:   charBlock('img/alice.svg', 'Alice'),
        message: flowing(stack),
        bob:     charBlock('img/bob.svg', 'Bob'),
        caption: caption('Alice realizes Bob loves the stories. She starts sending random silliness through NiceText, just for fun.'),
      });
    },
  },
  {
    id: 'alice-busted',
    chapter: "NiceText Smuggles. It Doesn't Encrypt.",
    mode: 'solo-bob',
    durationMs: 7000,
    render: (root) => buildSoloBob(root, {
      bob:  charBlock('img/eve.svg', 'Eve'),
      work: messageStack(
        svgNoteCard({ label: 'Cover Story:', body: 'Once upon a time...' }),
        svgNoteCard({ label: 'Suspicion:', body: 'NiceText?' }),
      ),
      caption: caption('Eventually, Eve recognizes the stories as NiceText. Alice is busted!'),
    }),
  },
  {
    id: 'eve-reverses',
    chapter: "NiceText Smuggles. It Doesn't Encrypt.",
    mode: 'solo-bob',
    durationMs: 8000,
    render: (root) => {
      // Mirror of bob-reveals layout: Eve sits in the character slot,
      // her workspace runs the same Reveal animation since she's
      // attempting to undo NiceText herself.
      const workSlot = el('div', 'slide-nicetext-anim-slot');
      buildSoloBob(root, {
        bob:  charBlock('img/eve.svg', 'Eve'),
        work: workSlot,
        caption: caption('A clever Eve can reveal the encrypted bits by guessing the style. NiceText is not strong encryption.', 'scene-caption-alert'),
      });
      const handle = mountPhaseAnim(workSlot, 'reveal');
      return () => handle.stop();
    },
  },
  {
    id: 'deniability',
    chapter: 'The Entertainment Defense',
    mode: 'transit',
    durationMs: 7000,
    render: (root) => buildTransit(root, {
      eve:      watcherEve('❓'),
      alice:    charBlock('img/alice.svg', 'Alice'),
      message:  flowing(svgNoteCard({ label: 'Secrets or Silliness:', body: ENCRYPTED, encrypted: true })),
      bob:      charBlock('img/bob.svg', 'Bob'),
      aliceKey: keyIcon(),
      bobKey:   keyIcon(),
      caption:  caption("Eve can't tell if she just revealed Alice's secret or her silliness."),
    }),
  },
  {
    id: 'alice-defends',
    chapter: 'The Entertainment Defense',
    mode: 'transit',
    durationMs: 7000,
    render: (root) => buildTransit(root, {
      eve:     watcherEve('❓'),
      alice:   charBlock('img/alice.svg', 'Alice'),
      message: flowing(svgNoteCard({ label: 'Alice Claims:', body: 'Just for fun!' })),
      bob:     charBlock('img/bob.svg', 'Bob'),
      caption: caption('Alice swears she only uses NiceText for fun. She might not be in trouble after all!'),
    }),
  },
  {
    id: 'cta',
    chapter: 'Try It Yourself',
    chapterHref: 'nicetext.html',
    mode: 'cta',
    durationMs: 12000,
    render: (root, slideshow) => {
      // The 3-phase narrated animation fills the cta slot. Chapter
      // title renders as a clickable pill via the mount header
      // (slideshow.js sees the chapterHref). The mount header's
      // narrationEl carries the dynamic per-phase explainer,
      // updated by mountNarratedAnim as the animation cycles.
      const animSlot = el('div', 'slide-nicetext-anim-slot');
      buildCta(root, {
        cta: animSlot,
      });
      const handle = mountNarratedAnim(animSlot, slideshow.narrationEl);
      return () => handle.stop();
    },
  },
];

const mount = document.getElementById('slideshow-mount');
if (mount) {
  // Preload character SVGs before constructing slides so render()
  // can clone synchronously.
  Promise.all([
    preloadSvg('img/alice.svg'),
    preloadSvg('img/bob.svg'),
    preloadSvg('img/eve.svg'),
  ]).then(() => {
    // loop: false so the slideshow holds on the final slide (the
    // 4-phase NiceText animation) forever rather than restarting.
    new Slideshow(mount, slides, { loop: false }).start();
  }).catch((err) => {
    console.error('slideshow svg preload failed', err);
  });
}
