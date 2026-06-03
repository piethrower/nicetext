# Paper references, bibliography for `whats-new.html`

Citations to keep handy when the modern paper page is built. These
trace the project's published history.

## Redistribution note

**The Springer proceedings papers below are copyrighted to their
publisher; we may not redistribute their PDFs (or any Springer-
licensed reformatting) from this repository.** The plain-text
versions of the Chapman & Davida papers preserved under
`OG-NiceText-C++/nicetext-0.9/doc/` (notably `icics97.txt`) are
author preprints / drafts, included for technical reference only;
they are not the publisher's typeset PDFs and must not be presented
as official Springer reprints. Cite the Springer DOI when
referencing these works.

The thesis is a separate matter: as the author, Mark T. Chapman
retains the right to republish it. The original archive ships a
PDF rendering alongside the PostScript and plain-text sources
(`OG-NiceText-C++/nicetext-1.0/doc/thesis.{ps,pdf,txt}`, identical
between 0.9 and 1.0). The PDF is promoted to `papers/thesis.pdf`
at the repo root and linked from the bibliography section of
`whats-new.html`.

## Citations

### 1. ICICS '97, original conference paper venue

- **Title:** Information and Communications Security
- **Subtitle:** First International Conference, ICICS'97, Beijing, China, November 11–14, 1997, Proceedings
- **Editors:** Yongfei Han, Tatsuaki Okamoto, Sihan Qing
- **Series / volume:** Lecture Notes in Computer Science (LNCS), volume 1334
- **Publisher / year:** Springer Berlin Heidelberg, 1997
- **DOI:** [10.1007/BFb0028456](https://link.springer.com/book/10.1007/BFb0028456)
- **ISBN (print):** 978-3-540-63696-0
- **ISBN (eBook):** 978-3-540-69628-5
- **NiceText paper:** "Hiding the Hidden: A Software System for Concealing Ciphertext as Innocuous Text" by Mark Chapman & George Davida (the source for `OG-NiceText-C++/nicetext-0.9/doc/icics97.txt`, preprint / author copy, not redistributable as the Springer reprint).

### 2. ISC 2001, large-scale automated NiceText

- **Title:** Information Security
- **Subtitle:** 4th International Conference, ISC 2001, Malaga, Spain, October 1–3, 2001, Proceedings
- **Editors:** George I. Davida, Yair Frankel
- **Series / volume:** Lecture Notes in Computer Science (LNCS), volume 2200
- **Publisher / year:** Springer Berlin Heidelberg, 2001
- **DOI:** [10.1007/3-540-45439-X](https://link.springer.com/book/10.1007/3-540-45439-X)
- **ISBN (print):** 978-3-540-42662-2
- **ISBN (eBook):** 978-3-540-45439-7
- **NiceText paper:** Chapter 11: "A Practical and Effective Approach to Large-Scale Automated Linguistic Steganography" by Mark Chapman, George I. Davida, Marc Rennhard, pp. 156–165. DOI: [10.1007/3-540-45439-X_11](https://doi.org/10.1007/3-540-45439-X_11).
- **Note:** Chapman's affiliation on this paper is Omni Tech Corporation (Pewaukee, USA), not UW-Milwaukee.

### 3. InfraSec 2002, plausible deniability

- **Title:** Infrastructure Security
- **Subtitle:** International Conference, InfraSec 2002, Bristol, UK, October 1–3, 2002, Proceedings
- **Editors:** George Davida, Yair Frankel, Owen Rees
- **Series / volume:** Lecture Notes in Computer Science (LNCS), volume 2437
- **Publisher / year:** Springer Berlin Heidelberg, 2002
- **DOI:** [10.1007/3-540-45831-X](https://link.springer.com/book/10.1007/3-540-45831-X)
- **ISBN (print):** 978-3-540-45831-9
- **NiceText paper:** "Plausible Deniability Using Automated Linguistic Steganography" by Mark Chapman & George Davida, pp. 276–287. DOI: [10.1007/3-540-45831-X_19](https://doi.org/10.1007/3-540-45831-X_19).

### 4. Master's thesis (UW-Milwaukee, 1997)

- **Title:** Hiding the Hidden: A Software System for Concealing Ciphertext as Innocuous Text
- **Author:** Mark T. Chapman
- **Advisor:** George I. Davida
- **Institution:** University of Wisconsin-Milwaukee
- **Year:** 1997
- **Source:** `OG-NiceText-C++/nicetext-1.0/doc/thesis.{ps,pdf,txt}` (PostScript, PDF, and plain-text rendering, all identical between 0.9 and 1.0). Author-retained rights, republishable. The PDF is promoted to `papers/thesis.pdf` and hosted alongside the modern paper page.

## How this file is consumed

- `whats-new.html` will render a "References" section
  (anchor-linked from inline citations like `[1]`, `[2]`, `[3]`,
  `[thesis]`) using the entries above, in this order.
- The bibliography header on the page may include the redistribution
  note in compact form ("Springer-copyrighted; cite via DOI"), but
  the full text of the redistribution note above is the canonical
  copy, keep this file in sync.
