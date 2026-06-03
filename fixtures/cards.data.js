// AUTO-GENERATED. Do not edit by hand.
//
// Source of truth: tools/byos/*.byos.json
// Regenerate with: node tools/build-all-fixtures.js
//
// Each entry is the public spec of one canonical byos card with the
// long-form byosID precomputed. js/src/byos.js getBYOSID consumes this
// array to resolve nicknames; tests and js/app.js import it
// synchronously as the single runtime source of truth for the card
// registry.
export default [
  {
    "version": 1,
    "name": "aesop",
    "label": "Aesop's Fables",
    "casualLabel": "Aesop's",
    "preview": "A wolf, meeting with a lamb astray from the fold, resolved to devour him.",
    "notes": "Aesop's Fables corpus: short narrative sentences, ~5K vocabulary. Corpus-dict + sentence model built from fixture-src/texts/aesop.txt; the corpus-dict's Huffman codes are weighted by per-word counts in the source text. Random sentence playback. Base block declares the same TWLIST union and augmentation as master (since aesop's corpus dict restricts master's vocabulary to corpus words); frequencies=['style'] means weight by the corpus's own word counts.",
    "story": {
      "style": "aesop",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/aesop-curated.txt"
    },
    "byosID": "v=1__sty=aesop__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "claude-magical",
    "label": "Magical Creatures",
    "casualLabel": "Magical Creatures",
    "preview": "The unicorn is a beast of singular virtue, taken only by maids of pure heart.",
    "notes": "Claude-authored magical-realism corpus (10 sections, see fixture-src/texts/claude-magical-*.txt). Random sentence playback. Base block declares the master TWLIST union with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "magical",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/claude-magical.txt"
    },
    "byosID": "v=1__sty=magical__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "claude-oratory",
    "label": "Civic Oratory",
    "casualLabel": "Civic Oratory",
    "preview": "My friends, we gather not to mourn, but to take up the work that remains.",
    "notes": "Claude-authored ceremonial oratory corpus (12 sections, see fixture-src/texts/claude-oratory-*.txt). Random sentence playback. Base block declares the same TWLIST union as the Random words card with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "oratory",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/claude-oratory.txt"
    },
    "byosID": "v=1__sty=oratory__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "claude-tasting",
    "label": "Tasting Notes",
    "casualLabel": "Tasting Notes",
    "preview": "Inky purple in the glass; the nose offers crushed raspberry and dried rose.",
    "notes": "Claude-authored wine/whisky/coffee tasting-notes corpus (12 sections, see fixture-src/texts/claude-tasting-*.txt). Random sentence playback. Base block declares the master TWLIST union with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "tasting",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/claude-tasting.txt"
    },
    "byosID": "v=1__sty=tasting__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "frankenstein",
    "label": "Frankenstein",
    "casualLabel": "Shelley",
    "preview": "You will rejoice to hear that no disaster has accompanied the commencement of an enterprise which you have regarded with such evil forebodings.",
    "notes": "Frankenstein corpus by Mary Shelley: early-nineteenth-century Gothic-Romantic register, epistolary frame, elevated diction with brooding sentiment. Base block declares the master TWLIST union with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "frankenstein",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/frankenstein-curated.txt"
    },
    "byosID": "v=1__sty=frankenstein__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "gilbert-sullivan",
    "label": "Gilbert & Sullivan",
    "casualLabel": "Gilbert & Sullivan",
    "preview": "I am the very model of a modern Major-General, I've information vegetable, animal, and mineral.",
    "notes": "The Complete Plays of Gilbert and Sullivan (PG 808). Libretti for H.M.S. Pinafore, The Mikado, The Pirates of Penzance, and the rest of the Savoy operas. Dense rhyme, patter-song lines. Master TWLIST union plus cmu-syllable for line-length hints alongside rhyme.",
    "story": {
      "style": "gilbert-sullivan",
      "sentence": "sequential",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "cmu-alliteration",
        "cmu-stress",
        "cmu-syllable",
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved",
        "rhyme"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/gilbert-sullivan-curated.txt"
    },
    "byosID": "v=1__sty=gilbert-sullivan__sen=s__voc=c__src=cmu-alliteration,cmu-stress,cmu-syllable,impf2p,impkimmo,mit,num-form-preserved,rhyme__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "jfk",
    "label": "JFK Inaugural",
    "casualLabel": "JFK",
    "preview": "Let every nation know that we shall pay any price to assure the survival of liberty.",
    "notes": "JFK inaugural-style oratory corpus: small (~545 types). Random sentence playback. Pairs with jfk-ordered.byos.json which builds the same corpus dict but with a sequential-replay model. Base block declares the master TWLIST union with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "jfk",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/jfk-curated.txt"
    },
    "byosID": "v=1__sty=jfk__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "limerick",
    "label": "Limerick",
    "casualLabel": "limerick",
    "preview": "There was a Young Lady whose chin, Resembled the point of a pin: So she had it made sharp, And purchased a harp, And played several tunes with her chin.",
    "notes": "Edward Lear's A Book of Nonsense (PG 982). Five-line AABBA verse with anapestic meter and a fixed 8-8-5-5-8 stressed-syllable shape. Master TWLIST union plus the metrical Poetry/Song twlists (cmu-syllable, cmu-stress) so the corpus-dict's slot types carry line-length and stress-pattern hints alongside the rhyme groups rhyme already provides.",
    "story": {
      "style": "limerick",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved",
        "rhyme",
        "cmu-syllable",
        "cmu-stress"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/edward-lear-nonsense-curated.txt"
    },
    "byosID": "v=1__sty=limerick__sen=r__voc=c__src=cmu-stress,cmu-syllable,impf2p,impkimmo,mit,num-form-preserved,rhyme__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "mit",
    "label": "Names and Places",
    "notes": "MIT names + places + CFG connectors. Pairs with grammars/mit-names.def. Deliberately built without the possessive/vowel-augmentation transforms that master applies, so the _UNIQUE_ drop-rule does not strip CFG connector words. hashedMergedTypes is OFF: the paired grammar references atomic source type names (name_male, name_female, place_general, ...) by string, and hashing the dict's type names would break the grammar's lookupTypeByName resolution.",
    "story": {
      "style": "flat"
    },
    "base": {
      "sources": [
        "mit",
        "connectors"
      ],
      "frequencies": [],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": false
    },
    "byosID": "v=1__sty=flat__src=connectors,mit__tb=p"
  },
  {
    "version": 1,
    "name": "moby-dick",
    "label": "Moby-Dick",
    "casualLabel": "Melville",
    "preview": "Call me Ishmael. Some years ago, having little or no money in my purse, I thought I would sail about a little and see the watery part of the world.",
    "notes": "Moby-Dick corpus by Herman Melville: mid-nineteenth-century American maritime epic, encyclopedic register mixing first-person narration with sermonic flights and cetological digression. Base block declares the master TWLIST union with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "moby-dick",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/moby-dick-curated.txt"
    },
    "byosID": "v=1__sty=moby-dick__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "nursery-rhyme",
    "label": "Nursery Rhyme",
    "casualLabel": "nursery rhyme",
    "preview": "Jack and Jill went up the hill, To fetch a pail of water; Jack fell down and broke his crown, And Jill came tumbling after.",
    "notes": "Mother Goose's Nursery Rhymes (PG 39784). Short rhymed verses with simple vocabulary, common in early-childhood reading. Master TWLIST union plus cmu-syllable so the corpus-dict's slot types carry line-length hints alongside rhyme.",
    "story": {
      "style": "nursery-rhyme",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "cmu-alliteration",
        "cmu-stress",
        "cmu-syllable",
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved",
        "rhyme"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/mother-goose-curated.txt"
    },
    "byosID": "v=1__sty=nursery-rhyme__sen=r__voc=c__src=cmu-alliteration,cmu-stress,cmu-syllable,impf2p,impkimmo,mit,num-form-preserved,rhyme__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "pride-and-prejudice",
    "label": "Pride and Prejudice",
    "casualLabel": "Austen",
    "preview": "It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife.",
    "notes": "Pride and Prejudice corpus by Jane Austen: Regency-era social-comedy register with measured, ironic, syntactically balanced sentences. Base block declares the master TWLIST union with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "pride-and-prejudice",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/pride-and-prejudice-curated.txt"
    },
    "byosID": "v=1__sty=pride-and-prejudice__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "random",
    "label": "* All English words",
    "notes": "Bundled TW-list union for the Random words card: KIMMO morphology, RHYME, F2P synonyms, MIT names+places (bare, no possessive augmentor), num-form-preserved (cardinals/ordinals/years/percent in form-preserving mode), claude2026. Vowel augmentation applied so the encoder can mark first-letter-vowel words. Possessives come naturally from kimmo (~9K entries) and rhyme (~7K entries) which already cover proper-name possessives; the MIT-specific possessive augmentor was vestigial and is dropped (grammars/mit-names.def never references the _pos types). CFG connectors are dropped too: the only card using them is MIT itself, and kimmo already covers all 12 connector words with richer types that sortDict's _UNIQUE_ drop-rule prefers. Built unweighted (frequencies=[]) and with default tieBreak alpha-asc.",
    "story": {
      "style": "flat"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved",
        "rhyme"
      ],
      "frequencies": [],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "byosID": "v=1__sty=flat__src=impf2p,impkimmo,mit,num-form-preserved,rhyme__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "shakespeare",
    "label": "Shakespeare",
    "casualLabel": "Shakespeare",
    "preview": "Tarry but a moment, gentle sir, and hear what news the messenger brings.",
    "chipId": "shak",
    "notes": "Shakespeare's complete works corpus: large vocabulary (~25K types) and rich sentence-shape variety (~64.7K unique shapes). Random sentence playback. Base block declares the master TWLIST union with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "shakespeare",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "cmu-alliteration",
        "cmu-stress",
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved",
        "rhyme"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/shakespeare-curated.txt"
    },
    "byosID": "v=1__sty=shakespeare__sen=r__voc=c__src=cmu-alliteration,cmu-stress,impf2p,impkimmo,mit,num-form-preserved,rhyme__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "sherlock-holmes",
    "label": "Sherlock Holmes",
    "casualLabel": "Sherlock",
    "preview": "To Sherlock Holmes she is always the woman; in his eyes she eclipses and predominates the whole of her sex.",
    "notes": "The Adventures of Sherlock Holmes corpus by Arthur Conan Doyle: late-Victorian detective-fiction register, first-person Watson narration, methodical and observational prose. Base block declares the master TWLIST union with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "sherlock-holmes",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/sherlock-holmes-curated.txt"
    },
    "byosID": "v=1__sty=sherlock-holmes__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "sonnet",
    "label": "Sonnet",
    "casualLabel": "sonnet",
    "preview": "From fairest creatures we desire increase, That thereby beauty's rose might never die, But as the riper should by time decease, His tender heir might bear his memory.",
    "notes": "Shakespeare's Sonnets (PG 1041), the standalone 154-sonnet sequence. Iambic pentameter, ABAB CDCD EFEF GG rhyme scheme. Master TWLIST union plus cmu-stress so the corpus-dict's slot types carry stress-pattern hints alongside rhyme.",
    "story": {
      "style": "sonnet",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved",
        "rhyme",
        "cmu-stress"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/shakespeare-sonnets-curated.txt"
    },
    "byosID": "v=1__sty=sonnet__sen=r__voc=c__src=cmu-stress,impf2p,impkimmo,mit,num-form-preserved,rhyme__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "tale-of-two-cities",
    "label": "A Tale of Two Cities",
    "casualLabel": "Dickens",
    "preview": "It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness.",
    "notes": "A Tale of Two Cities corpus by Charles Dickens: Victorian historical-novel register, expansive periodic sentences, French-Revolution London/Paris setting. Base block declares the master TWLIST union with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "tale-of-two-cities",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/tale-of-two-cities-curated.txt"
    },
    "byosID": "v=1__sty=tale-of-two-cities__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "tanka",
    "label": "Tanka",
    "casualLabel": "tanka",
    "preview": "Spring, spring has come, while yet the landscape bears its fleecy burden of unmelted snow! Now may the zephyr gently 'gin to blow, to melt the nightingale's sweet frozen tears.",
    "notes": "Classical Japanese verse from Japanese Literature (PG 19264), Epiphanius Wilson's 1900 anthology of waka / tanka in Victorian English translation. Five-line 5-7-5-7-7 form, often nature-themed. Master TWLIST union plus cmu-syllable for the line-length structure (no rhyme requirement in classical waka).",
    "story": {
      "style": "tanka",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved",
        "rhyme",
        "cmu-syllable"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/japanese-classical-verse-curated.txt"
    },
    "byosID": "v=1__sty=tanka__sen=r__voc=c__src=cmu-syllable,impf2p,impkimmo,mit,num-form-preserved,rhyme__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "texting-teen",
    "label": "Texting Teen 📱💬",
    "casualLabel": "Texting Teen",
    "preview": "omg bestie 💖 pizza tonight 🍕🎉 fr fr no cap 🧢 bye 💕",
    "notes": "Texting Teen corpus 📱💖✨: short one-line tween/teen text messages, emoji-saturated. Showcases the full Emoji 16 source family (single emoji + CLDR phrases + hand-curated emoji phrases + curated keyword filter) plus all three cross-modal augmentations (emoji-into-words + words-into-emoji + narrow mixed phrases) layered on top of the master TWLIST union. Random sentence playback. frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "texting-teen",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved",
        "emoji16",
        "emoji-cldr-names-16",
        "emoji-curated-phrases-16",
        "emoji16-curated-keywords"
      ],
      "augment": {
        "emojiIntoWords": {
          "enabled": true,
          "intensity": 5
        },
        "wordsIntoEmoji": {
          "enabled": true,
          "intensity": 5
        }
      },
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/texting-teen*.txt"
    },
    "byosID": "v=1__sty=texting-teen__sen=r__voc=c__src=emoji-cldr-names-16,emoji-curated-phrases-16,emoji16,emoji16-curated-keywords,impf2p,impkimmo,mit,num-form-preserved__eiw=5__wie=5__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "walden",
    "label": "Walden",
    "casualLabel": "Thoreau",
    "preview": "I lived alone, in the woods, a mile from any neighbor, in a house which I had built myself, on the shore of Walden Pond.",
    "notes": "Walden corpus by Henry David Thoreau: mid-nineteenth-century American transcendentalist register, reflective first-person essay with naturalist observation and aphoristic moralizing. Base block declares the master TWLIST union with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "walden",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/walden-curated.txt"
    },
    "byosID": "v=1__sty=walden__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "war-of-the-worlds",
    "label": "War of the Worlds",
    "casualLabel": "Wells",
    "preview": "No one would have believed in the last years of the nineteenth century that this world was being watched keenly and closely by intelligences greater than man's.",
    "notes": "The War of the Worlds corpus by H. G. Wells: late-Victorian scientific-romance register, first-person reportorial narration of Martian invasion with measured, observational prose. Base block declares the same TWLIST union as the Random words card with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "war-of-the-worlds",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/war-of-the-worlds-curated.txt"
    },
    "byosID": "v=1__sty=war-of-the-worlds__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  },
  {
    "version": 1,
    "name": "wizoz",
    "label": "Wizard of Oz",
    "casualLabel": "Wizard of Oz",
    "preview": "Dorothy looked down the long road and saw a great green city in the distance.",
    "notes": "The Wizard of Oz corpus: narrative-fiction sentence shapes, ~2.8K vocabulary. Random sentence playback. Base block declares the master TWLIST union with vowel augmentation; frequencies=['style'] weights the corpus dict by per-word counts in the source text.",
    "story": {
      "style": "wizoz",
      "sentence": "random",
      "vocabulary": "corpus"
    },
    "base": {
      "sources": [
        "impf2p",
        "impkimmo",
        "mit",
        "num-form-preserved"
      ],
      "frequencies": [
        "style"
      ],
      "tieBreak": "prefer-shorter",
      "hashedMergedTypes": true
    },
    "rewriter": {
      "xanax": {
        "enabled": true,
        "intensity": 100
      }
    },
    "build": {
      "corpus": "fixture-src/texts/wizoz-curated.txt"
    },
    "byosID": "v=1__sty=wizoz__sen=r__voc=c__src=impf2p,impkimmo,mit,num-form-preserved__frq=style__tb=p__xa=100"
  }
];
