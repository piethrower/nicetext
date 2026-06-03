// Tutorial steps for the NiceText guided walkthrough. Penny narrates;
// the user clicks "Next" to advance. No gating: the underlying utility
// (app.js) is fully functional throughout. Penny is overlay only.
//
// Copy avoids directional words ("left", "right", "below") because the
// page reflows between landscape and portrait; instead it points at
// labelled UI elements ("the Your Secret box", "the Hide it button").

import { Penny } from './penny.js';

const NEXT  = '<button class="penny-next" type="button">Next</button>';
const SKIP  = '<button class="penny-skip" type="button">Skip tutorial</button>';
const CLOSE = '<button class="penny-skip" type="button">Close Tutorial</button>';

const steps = [
  {
    narrative: `
      <p>Hi! I'm Penny. Wanna see how to smuggle a secret message inside a story?</p>
      ${NEXT} ${SKIP}
    `,
  },
  {
    narrative: `
      <p>Switch to the <strong>Secrets or Silliness</strong> tab. In the big textarea, type some silliness, like <em>"meet me by the swings"</em>.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Click <strong>Conceal</strong> up in the navbar. The page jumps to <strong>The Cover Story</strong> tab, where your message has become a story.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Your secret is smuggled inside the words of the cover story. Reads like a normal story, doesn't it?</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Click <strong>Conceal</strong> again. Same secret, different cover story every time.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Switch to the <strong>Story Style</strong> tab and click a different <strong>Premade</strong> card. Then hit <strong>Conceal</strong> again. A whole new kind of story, from fables to political speeches, even Shakespeare.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Now imagine that cover story arrived from a friend. Go back to <strong>Secrets or Silliness</strong> and clear out what's there. Then click <strong>Reveal</strong> in the navbar. A popup opens so you can confirm the style and the cover. Click <strong>Reveal</strong> inside it, and your friend's message appears in <strong>Secrets or Silliness</strong>.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Switch back to <strong>Secrets or Silliness</strong> and click <strong>Random</strong> for a made-up secret, then <strong>Conceal</strong>. Looks like just another silly story. If someone figures out you're using this software to smuggle, well, "nothing to see here, just a made-up secret because I like the cover story."</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>That's the basics. Load any file as a secret with the <strong>Load</strong> button in <strong>Secrets or Silliness</strong>, or drag and drop one onto the textarea. Drop several files, or one big one, and Pipeline mode pops up to process them in a batch.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Over in <strong>Story Style</strong>, flip the <strong>Premade | Custom</strong> toggle to <strong>Custom</strong>. The Premade cards hide and a mix of controls appears: base word lists, an optional corpus, and a few knobs.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Inside Custom, try the fun knobs. In <strong>Emoji</strong>, pick <strong>Sprinkle</strong> to season your covers with emojis, and in <strong>Rewriters</strong>, set Voice to <strong>Pirate</strong> so every cover sounds like a swashbuckler. For the emojis and other codebook words to actually show up, set <strong>Vocabulary</strong> to <strong>Expand to include codebook words</strong>. Then click <strong>Build</strong> in the navbar to make your custom style active. There's also a <strong>Pro</strong> mode next to Custom for power users who want even more controls.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Every style is its own special way of disguising words. You and your friend need to use the <em>same style</em> for <strong>Reveal</strong> to work. Otherwise it just plays back gibberish.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Want a friend to read what you made? After <strong>Conceal</strong>, the <strong>Share</strong> button in the navbar lights up. It opens a popup with two parts: share the style, and share the cover. Send them through different channels: one by chat and the other by email, for example. That way anyone snooping on just one channel can't easily <strong>Reveal</strong>.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>In that same Share popup, you can dress the cover up to look like an ordinary file. Pick a <strong>File type</strong> like Markdown, HTML, or Python, and optionally stack <strong>Wrapping layers</strong> like base64 or gzip on top. A casual observer just sees something ordinary.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p><strong><em>WARNING:</em></strong> A serious cryptanalyst can recover the secret from just the Cover Story. NiceText is steganography, not encryption, and a determined adversary has many ways to crack it. If you or your friend are casual users, reveal might be very difficult without the exact style. That does not make it secure.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>For best results, use another encryption tool to securely encrypt your secret first, then <strong>Load</strong> the file into <strong>Secrets or Silliness</strong>, click <strong>Conceal</strong>, and share the style and cover story as usual (but never the encrypted secret file itself). By combining my smuggling power with high-grade encryption from another tool, you get the best of both worlds, as long as you are authorized to use such tools.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Here's the kicker. If you combine encryption with smuggling, then when you do get busted smuggling, all they get from the cover story is random-looking gibberish, unless they have the password or key used by the other tool. Was it a real secret, or noise you made for fun?</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Curious whether a cover story might tip off an eavesdropper? The <strong>Eve</strong> tab takes a cover story and reports whether it looks like NiceText output. It's for advanced users. Just know it's there. For the full story on how all of this works, explore my <a href="whats-new.html" target="_blank" rel="noopener">research section</a>.</p>
      ${NEXT}
    `,
  },
  {
    narrative: `
      <p>Have fun! I'm gonna go outside and play. Roo Roo Roo!</p>
      ${CLOSE}
    `,
  },
];

const anchor = document.getElementById('penny-anchor');
const dock = document.getElementById('penny-dock');
// Toggle button used to live inside the dock. Moved to the navbar
// as part of the 2026-05-16 navbar pass; the click handler logic is
// unchanged, just bound to the new button.
const dockToggle = document.getElementById('topbar-tutorial-toggle');

// Tutorial open/closed state survives page reloads within the same
// browser session via a session cookie. Matches the project's
// established pattern for chrome state (see js/theme.js, same
// readCookie/writeCookie shape, same SameSite=Lax, no Max-Age so
// the cookie clears on full browser close). UI-pref only (boolean);
// rule 27's no-persistence rule covers payload/cover content, not
// chrome state.
const COOKIE_NAME = 'nicetext-penny-collapsed';
function readCookie(name) {
  for (const part of document.cookie.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v || '');
  }
  return null;
}
function writeCookie(name, value) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; SameSite=Lax`;
}
function readCollapsedPref() {
  return readCookie(COOKIE_NAME) === '1';
}
function writeCollapsedPref(collapsed) {
  writeCookie(COOKIE_NAME, collapsed ? '1' : '0');
}

function setCollapsed(collapsed) {
  if (!dock) return;
  dock.classList.toggle('collapsed', collapsed);
  document.body.classList.toggle('penny-collapsed', collapsed);
  if (dockToggle) {
    dockToggle.setAttribute('aria-pressed', String(collapsed));
    dockToggle.setAttribute(
      'aria-label',
      collapsed ? 'Open tutorial' : 'Close tutorial'
    );
  }
  writeCollapsedPref(collapsed);
}

// pennyActive tracks whether a Penny instance is currently driving
// the tutorial. False when she's been dismissed (Skip / Done) or
// never started; true while she's running, regardless of whether the
// dock is currently collapsed. The dock's Hide/Show button does not
// affect this flag, collapsing only hides the dock visually.
let pennyActive = false;

function startPenny() {
  if (!anchor) return;
  // Clear any leftover dismissed-state classes/content so the new
  // Penny instance starts from a clean anchor. dismiss() adds
  // .penny-hidden (opacity 0) and schedules a clear on a 250 ms
  // timeout: clearing both up front avoids both the visible-but-
  // invisible bug and the race window.
  anchor.classList.remove('penny-hidden');
  anchor.replaceChildren();
  const penny = new Penny(anchor, steps, {
    onComplete: () => {
      pennyActive = false;
      setCollapsed(true);
    },
  });
  penny.start();
  pennyActive = true;
}

if (anchor) {
  // Honor the persisted collapsed pref: if the developer dismissed
  // Penny earlier this session, leave the dock collapsed and skip the
  // Penny instance, the dockToggle click below will start her on
  // demand. First-time loads (no stored pref) default to expanded.
  if (readCollapsedPref()) {
    setCollapsed(true);
  } else {
    startPenny();
  }
}

if (dockToggle) {
  dockToggle.addEventListener('click', () => {
    const collapsing = !dock.classList.contains('collapsed');
    setCollapsed(collapsing);
    // Show Penny when she's no longer running restarts the tutorial.
    // Wait for the dock-expansion CSS transition (180 ms) to settle
    // before instantiating Penny, otherwise the snap-to-line
    // measurement uses the transitional (still-shrunk) dock height
    // and clamps the new bubble to 3/4 of a line.
    if (!collapsing && !pennyActive) setTimeout(startPenny, 220);
  });
}
