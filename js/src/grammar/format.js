// Format-token interpretation. Port of OG bits2txt.cc printPunctuation().
//
// Special whole-string tokens (sentmdl.h):
//   "Cap"          : capitalize next word
//   "CAPSLOCKON"   : capitalize all subsequent words until capslockoff
//   "capslockoff"  : release CAPSLOCK
//
// Quoted literal:
//   "^...^"        : emit inner contents verbatim, no further interpretation
//
// Otherwise interpreted char-by-char:
//   'n'            : newline; clears the pending-space flag
//   'e'            : empty (skip)
//   ' '            : conditional space (only if pending-space was set)
//   '('            : at START of multi-char punct: emit a space first
//   default        : emit the char and set pending-space = true
//
// Browser-safe ESM. No Node deps.

// Lexer's WORD_CHAR class (kept in sync with lexer.js): Latin script
// letters + digits + `&#@$%*+`. EXT chars (`'`, `.`, `-`, `://`) extend
// a WORD when followed by a WORD_CHAR; `'` extends when followed by
// Latin specifically.
const WORD_CHAR_RE = /[\p{Script=Latin}0-9&#@$%*+]/u;
const LATIN_RE = /\p{Script=Latin}/u;
// Emoji-cluster ingredients (kept in sync with EMOJI_CLUSTER_RE in
// lexer.js). Any two adjacent emits whose boundary lands inside this
// set fuse into a single emoji WORD token, even across the lexer's
// "Latin doesn't fuse with emoji" rule, `💻💻💻💻💻💻💻` + `❤` lexes
// as one 8-pictographic cluster, breaking a phrase entry whose
// stored form is just the 7 computers. Uses the ES2024 `v` flag
// (Unicode-sets mode) rather than `u`, because Chrome's `u`-mode
// regex engine through 145 has a bug where `[\p{Extended_Pictographic}]$`
// fails to match a supplementary-plane code point at end-of-string
// (BMP pictographics like `❤` still match, supplementary ones like
// `💻` don't). `v` mode handles both correctly across every
// supported runtime (Chrome ≥ 116, Firefox ≥ 116, Safari ≥ 17,
// Node ≥ 20.4). js/runtime-check.js feature-detects `v` at page
// load and surfaces a top-of-page banner if the runtime is older.
const EMOJI_FUSABLE_CLASS =
  '[\\p{Extended_Pictographic}\\p{Regional_Indicator}\\p{Emoji_Modifier}\\uFE0F\\u200D]';
const EMOJI_FUSABLE_START_RE = new RegExp('^' + EMOJI_FUSABLE_CLASS, 'v');
const EMOJI_FUSABLE_END_RE = new RegExp(EMOJI_FUSABLE_CLASS + '$', 'v');
function leadingFusable(s) {
  if (s.length === 0) return false;
  if (WORD_CHAR_RE.test(s[0])) return true;
  if (EMOJI_FUSABLE_START_RE.test(s)) return true;
  if (s.length >= 2) {
    if (s[0] === "'" && LATIN_RE.test(s[1])) return true;
    if ((s[0] === '.' || s[0] === '-') && WORD_CHAR_RE.test(s[1])) return true;
  }
  if (s.length >= 4 && s.startsWith('://') && WORD_CHAR_RE.test(s[3])) return true;
  return false;
}
function trailingFusable(s) {
  if (s.length === 0) return false;
  const last = s[s.length - 1];
  if (WORD_CHAR_RE.test(last)) return true;
  // Symmetric to leadingFusable's emoji branch, trailing emoji-cluster
  // chars fuse with a following emoji into one WORD token.
  if (EMOJI_FUSABLE_END_RE.test(s)) return true;
  // Trailing apostrophe absorbs a following Latin char via WORD_RE's
  // prefix `'(?=Latin)`, or via prefix `[DdOoLl]'` when the literal's
  // prior char is one of those (e.g. `^l'^` + `fm` → `l'fm` lexes as
  // one WORD). Either way the combined cover collapses to a single
  // WORD and the next emit's bits leak into the lexer's unknown-token
  // gap.
  if (last === "'") return true;
  // EXT chars `.` `-` absorb a following WORD_CHAR only when a CORE
  // precedes them inside the literal (`^abc.^` + `def` → `abc.def`
  // fuses via CORE+EXT; `^.^` + `def` doesn't because EXT requires a
  // CORE first).
  if ((last === '.' || last === '-') && s.length >= 2) {
    return WORD_CHAR_RE.test(s[s.length - 2]);
  }
  // `://` EXT, same rule, CORE must precede.
  if (s.length >= 4 && s.slice(-3) === '://') {
    return WORD_CHAR_RE.test(s[s.length - 4]);
  }
  return false;
}

export function createFormatter() {
  const state = {
    cap: false,        // CAPSLOCK on/off
    shift: false,      // cap next word
    space: false,      // emit a space before the next word
    firstWord: true,   // (currently informational)
    italicsOpen: false, // toggled on each '_' so `_word_` renders flush
    out: [],
  };

  function pushChar(ch) { state.out.push(ch); }
  function pushString(s) { state.out.push(s); }

  function emitWord(word) {
    if (state.space) { pushChar(' '); state.space = false; }
    let w = word;
    if (state.cap) {
      w = word.toUpperCase();
    } else if (state.shift) {
      w = word.charAt(0).toUpperCase() + word.slice(1);
      state.shift = false;
    }
    pushString(w);
    state.space = true;
    state.firstWord = false;
  }

  function emitPunct(value) {
    if (value === 'Cap') { state.shift = true; return; }
    if (value === 'CAPSLOCKON') { state.cap = true; return; }
    if (value === 'capslockoff') { state.cap = false; return; }
    if (value.length >= 2 && value.startsWith('^') && value.endsWith('^')) {
      const inner = value.slice(1, -1);
      if (inner.length > 0) {
        // Insert a separating space before the literal whenever its
        // first code point would fuse with a preceding WORD at decode
        // time, and set state.space afterwards so the next emit sees
        // a fusable trailing boundary. The previous check used
        // `[A-Za-z0-9_]`, which missed WORD-class chars beyond ASCII
        // (`\p{Script=Latin}`, `&#@$%*+`) and WORD-extender chars
        // (`'` + Latin, `.` + WORD_CHAR, `-` + WORD_CHAR, `://` +
        // WORD_CHAR per WORD_RE in lexer.js). A `^&^` or `^@k^`
        // literal would then glue to an adjacent dict-WORD; the
        // fused mega-token looks up as `unknown` at decode (0 bits)
        // while the encoder consumed real bits for the adjacent
        // slot: instant round-trip failure.
        if (state.space && leadingFusable(inner)) pushChar(' ');
        pushString(inner);
        state.space = trailingFusable(inner);
      }
      return;
    }
    if (value === '_') {
      // Italics-pair handling. PG plain-text uses `_word_` for italics.
      // Opening `_`: honor any pending space (so the underscore comes after
      //   whitespace from the previous word), then push '_' and clear space
      //   so the next word glues to it (`_word`, not `_ word`).
      // Closing `_`: glue to the just-emitted word (`word_`, no leading
      //   space), then leave space=true so the NEXT word gets one.
      if (state.italicsOpen) {
        pushChar('_');
        state.space = true;
        state.italicsOpen = false;
      } else {
        if (state.space) pushChar(' ');
        pushChar('_');
        state.space = false;
        state.italicsOpen = true;
      }
      return;
    }
    if (value.length > 1 && value.charAt(0) === '(') {
      pushChar(' ');
      state.space = false;
    }
    for (const ch of value) {
      switch (ch) {
        case 'n': pushChar('\n'); state.space = false; break;
        case 'e': break;
        case ' ': if (state.space) { pushChar(' '); /* leave space=true */ } break;
        default:  pushChar(ch); state.space = true; break;
      }
    }
  }

  function flush() { return state.out.join(''); }

  // Streaming variant of flush: returns whatever is currently in the
  // output buffer and clears it, so the next drain only sees newly
  // emitted text. Formatter state (cap/shift/space/italicsOpen) is
  // preserved across drains so word spacing keeps working across the
  // chunk boundary.
  function drain() {
    if (state.out.length === 0) return '';
    const s = state.out.join('');
    state.out.length = 0;
    return s;
  }

  return { emitWord, emitPunct, flush, drain, state };
}
