# Corpora

Raw text and word-list inputs for the dict and model-table builders.
Companion to `docs/builders.md`, which describes the tools that
consume these files and produce `fixtures/*.json.gz` artifacts.

## Corpora copied into ./fixture-src/

- `texts/jfk.txt` (16 KB): JFK inaugural
- `texts/aesop.txt` (240 KB): Aesop's Fables
- `texts/wizoz.txt` (230 KB): Wizard of Oz
- `twlist/mitlist/{name_male,name_female,name_family,name_other,place}`: pre-tagged word lists from MIT (Bob Baldwin / Matt Bishop / Daniel Klein collection)
- Shakespeare (5.5 MB uncompressed) skipped to keep repo light; copy from `OG-NiceText-C++/nicetext-1.0/examples/texts/shak/shaks12.txt.gz` if needed.

## Claude-authored corpora

Three large corpora authored by Claude (Anthropic) for use as
model-table sources. Each is built up section by section across
multiple sessions, then concatenated and processed via
`tools/build-corpus-dict.js` + `tools/build-model-table.js`.

Voice criteria: pattern-rich shapes, self-contained at sentence /
paragraph level, drone-friendly (no document-level structure
required), register survives master-dict vocab swap.

Per-section files: `fixture-src/texts/claude-<name>-NN.txt` (NN
zero-padded). Concatenate before building:
`cat fixture-src/texts/claude-<name>-*.txt > fixture-src/texts/claude-<name>.txt`.
Section order does not matter for model-table generation; sections
are independent.

### claude-magical-creatures

Medieval bestiary register (corpus filename `claude-magical`, display label "Magical Creatures"): Pliny / Physiologus / Aberdeen Bestiary. Each entry 1–3 paragraphs, uniform incantatory cadence, no narrative arc.

- [x] 1. Beasts of the forest and field (unicorns, satyrs, manticores, etc.): `claude-magical-01.txt`
- [x] 2. Beasts of the deep waters (kraken, leviathan, mermen, sea-bishops): `claude-magical-02.txt`
- [x] 3. Birds and creatures of the air (phoenix, roc, harpy, simurgh): `claude-magical-03.txt`
- [x] 4. Beasts of mountain and crag (dragons, gryphons, wyverns, cockatrices): `claude-magical-04.txt`
- [x] 5. Creatures of fire and the infernal regions (salamander, hellhound, fire-drake), `claude-magical-05.txt`
- [x] 6. Beasts of the desert and the far East (gorgon, sphinx, chimera): `claude-magical-06.txt`
- [x] 7. Subterranean creatures (gnomes, blind worms, cave-bears, deep-folk): `claude-magical-07.txt`
- [x] 8. Creatures of twilight and dream (kelpie, will-o'-wisp, banshee, wild hunt), `claude-magical-08.txt`
- [x] 9. Domestic and adjacent creatures (philosophical hare, herald-cock, messenger-bee, sober owl), `claude-magical-09.txt`
- [x] 10. Lesser-known and obscure creatures (catchall: invented, regional, half-forgotten), `claude-magical-10.txt`

Structural ingredients (mix freely within each entry):

- Opening declaration: *"THE X is a beast..."*, *"THE X has the body of..."*, *"THE X is found in..."*
- Anatomical catalogue: *"the body of a lion, the face of a man, and the tail of a scorpion"*
- Habitat clause: *"found in the deserts of...", "haunts the borders of...", "dwells in the further reaches of..."*
- Diet and behaviour: *"feeds upon...", "is fond of...", "is wont to lure..."*
- Reproduction note: *"breeds only in spring", "its young are born blind for a fortnight"*
- Method of capture: *"taken only by the nets of patient men", "approached only with a hound trained from a pup"*
- Authority citation: *"Pliny relates that...", "the moralists declare...", "Holinshed records under the chapter of doubtful animals"*
- Moral or allegorical reading: *"the ancients held that this signifies the singular nature of virtue"*
- Singular fact: *"alone among beasts, it is said to laugh"*
- Defence/limitation: *"cannot cross running water", "will not pass beneath an arch of rowan"*
- Closing reservation: *"the matter is held by some to be doubtful", "few that have been taken have lived above a fortnight"*

### claude-tasting

Wine / spirits / coffee / tea tasting-note register. Each note 2–4 sentences, ritualized vocabulary (nose, palate, finish, structure, tannins, length), self-contained.

- [x] 1. Red wines: `claude-tasting-01.txt`
- [x] 2. White wines: `claude-tasting-02.txt`
- [x] 3. Rosés and orange wines: `claude-tasting-03.txt`
- [x] 4. Sparkling wines and champagnes: `claude-tasting-04.txt`
- [x] 5. Fortified wines (port, sherry, madeira, vermouth): `claude-tasting-05.txt`
- [x] 6. Single-malt scotch: `claude-tasting-06.txt`
- [x] 7. Bourbon, rye, and other American whiskies: `claude-tasting-07.txt`
- [x] 8. Cognacs, armagnacs, and other brandies: `claude-tasting-08.txt`
- [x] 9. Single-origin coffees: `claude-tasting-09.txt`
- [x] 10. Teas (puerh, oolong, green, white, black): `claude-tasting-10.txt`
- [x] 11. Cocktails (classic and modern composed): `claude-tasting-11.txt`
- [x] 12. Olive oils, vinegars, and pretentious adjacencies: `claude-tasting-12.txt`

Structural ingredients (mix freely within each note):

- Header opener: *"Producer, Region/Appellation, Vintage."*: sometimes with vineyard or cuvée name in quotes
- Visual: *"A pale ruby in the glass...", "Inky, opaque purple...", "A bright garnet of medium intensity..."*
- Nose/aroma stack: *"The nose offers crushed raspberry and dried rose petal, then deepens into..."*
- Palate body: *"The palate is silken / muscular / lifted / structured / unhurried..."*
- Tannin/acidity note: *"fine-grained tannins that resolve...", "bright acidity that keeps the structure from settling"*
- Finish: *"The finish is long, mineral, and threaded with iron"*
- Context/aging: *"Drinks well now but will be a different wine in 2030", "Best decanted; better still, opened the night before"*
- Closing verdict: *"A wine of restraint rather than display", "A wine that has finished arguing"*
- Faintly hostile aside: *"the oak is present though no longer dominant", "the alcohol is present but well-clothed"*
- Pairing / serving suggestion: *"pairs well with grilled beef and uncomplicated company"*

### claude-oratory

Generic civic-ceremonial register. Strictly non-partisan, no policy positions, no era-specific markers. Pure rhetorical scaffolding: tricolons, anaphora, antitheses, apostrophes to abstract civic virtues. Each rhetorical move self-contained at sentence/paragraph level.

- [x] 1. Civic dedication (opening of library / hospital / bridge / school): `claude-oratory-01.txt`
- [x] 2. Memorial address (deceased public servant, generic): `claude-oratory-02.txt`
- [x] 3. Retirement / valedictory address: `claude-oratory-03.txt`
- [x] 4. Generic stump speech (rally, no policy content): `claude-oratory-04.txt`
- [x] 5. Inaugural-style address (taking up a duty): `claude-oratory-05.txt`
- [x] 6. Holiday oration (civic celebration, Fourth-of-July register): `claude-oratory-06.txt`
- [x] 7. Commencement / graduation address: `claude-oratory-07.txt`
- [x] 8. Call-to-conscience speech (we have fallen short, must do better): `claude-oratory-08.txt`
- [x] 9. Foreign-affairs register (without specific positions): `claude-oratory-09.txt`
- [x] 10. Morale-and-resolve / rallying speech: `claude-oratory-10.txt`
- [x] 11. State-funeral oratory: `claude-oratory-11.txt`
- [x] 12. Banquet toasts and benedictions: `claude-oratory-12.txt`

Structural ingredients (mix freely within each speech):

- Direct address: *"My friends...", "Fellow citizens...", "Honoured guests...", "To those who would say..."*
- Tricolon: *"of the people, by the people, for the people"*
- Anaphora: *"We will not rest... we will not yield... we will not forget..."*
- Antithesis: *"not because it is easy, but because it is hard"*
- Catalogue: *"From the smallest hamlet to the greatest city, from the X to the Y..."*
- Negative parallel: *"Let no one say... let no one suppose... let no one imagine..."*
- Rhetorical question + immediate answer: *"And what is the measure of a nation? It is..."*
- Memorial / ancestral nod: *"Those who came before us...", "the names recorded on the plaque..."*
- Apostrophe to abstract virtue: *"Liberty has always demanded...", "Justice asks of us..."*
- Acknowledgement chain: *"To the architect... to the craftsmen... to the donors... and above all..."*
- Sweeping close: *"And so, my friends, we go forward..."*
- Ceremonial declaration: *"I declare this library open", "Let the lamps be lit"*

### Self-driving workflow

When a fresh session is asked to *"draft the next corpus section"* (or similar), follow these steps exactly:

1. Find the first `[ ]` (unchecked) item in the three section lists above. Scan top to bottom: magical-creatures first, then tasting, then oratory.
2. Note its number NN, name, and parent corpus (`claude-magical` / `claude-tasting` / `claude-oratory`). Re-read the matching structural-ingredients list above.
3. Produce **3,000–5,000 words** in the matching voice, drawing on the structural ingredients. Vary opening shapes; avoid repeating any single sentence skeleton more than three or four times. No document-level frame (no greeting / close / chapter arc): each entry self-contained.
4. Write to `fixture-src/texts/claude-<name>-NN.txt` with NN zero-padded to two digits.
5. Edit this file: change that line's `[ ]` to `[x]` and append ``, `claude-<name>-NN.txt` `` to the line.
6. Stop. One section per session. Brief summary to the developer; do **not** auto-advance to the next.

If the developer asks for a specific section by name (*"do claude-tasting section 7"*), draft that one regardless of order, and still check it off.

### Building dicts and model tables from these corpora

When enough sections exist, concatenate and build (verify exact CLI syntax against existing tool examples):

```sh
cat fixture-src/texts/claude-magical-*.txt > fixture-src/texts/claude-magical.txt
node tools/build-corpus-dict.js fixture-src/texts/claude-magical.txt fixtures/claude-magical.dict.json.gz claude-magical
node tools/build-model-table.js fixture-src/texts/claude-magical.txt fixtures/claude-magical.dict.json.gz fixtures/claude-magical.model.json.gz
```
