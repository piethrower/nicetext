// Inline SVG generators. Builds SVG-based UI primitives in JS so
// the result scales as a unit (viewBox + preserveAspectRatio) and
// every visual property is driven by CSS, themes / fonts / colors /
// border style are all controlled by class selectors in the standard
// stylesheets, not by attributes baked into JS.

const SVG_NS = 'http://www.w3.org/2000/svg';

// svgNoteCard builds a self-scaling "note card": a rectangular border
// containing a small label above a larger body line. The whole SVG
// auto-fits its viewBox to the rendered text on first layout, so the
// card grows/shrinks with its container without overflow.
//
// Inner elements always carry these structural classes for CSS to
// target:
//   .note-card  : root <svg>
//   .note-border : <rect>
//   .note-label : <text> (upper, smaller)
//   .note-body  : <text> (lower, larger)
//
// Optional rootClass / rootId go on the root <svg> for scoped CSS
// overrides per instance.
//
// Returns the SVG element. Caller appends it to the DOM; auto-fit
// runs on first layout via ResizeObserver.
export function svgNoteCard({ label, body, encrypted, rootClass, rootId } = {}) {
  const hasLabel = label != null && label !== '';
  const hasBody  = body  != null && body  !== '';
  if (!hasLabel && !hasBody) {
    throw new Error('svgNoteCard: label and/or body required');
  }

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('note-card');
  if (encrypted) svg.classList.add('note-encrypted');
  if (rootClass) svg.classList.add(rootClass);
  if (rootId) svg.id = rootId;
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  // Hidden until the first layout pass sets a real viewBox; avoids
  // the 300x150 default-size flash that an SVG without intrinsic
  // dimensions would otherwise show.
  svg.style.visibility = 'hidden';

  const rect = document.createElementNS(SVG_NS, 'rect');
  rect.classList.add('note-border');
  rect.setAttribute('x', '0');
  rect.setAttribute('y', '0');
  svg.appendChild(rect);

  let labelEl = null;
  if (hasLabel) {
    labelEl = document.createElementNS(SVG_NS, 'text');
    labelEl.classList.add('note-label');
    labelEl.setAttribute('text-anchor', 'middle');
    labelEl.setAttribute('dominant-baseline', 'hanging');
    labelEl.textContent = label;
    svg.appendChild(labelEl);
  }

  let bodyEl = null;
  if (hasBody) {
    bodyEl = document.createElementNS(SVG_NS, 'text');
    bodyEl.classList.add('note-body');
    bodyEl.setAttribute('text-anchor', 'middle');
    bodyEl.setAttribute('dominant-baseline', 'hanging');
    bodyEl.textContent = body;
    svg.appendChild(bodyEl);
  }

  // Layout constants are in SVG user units. They get scaled along
  // with everything else when the viewBox maps onto the slot.
  const PAD_X = 16;
  const PAD_Y = 12;
  const GAP   = 10;

  let laidOut = false;
  let vbWidth = 0;
  const updateRadius = () => {
    if (!laidOut) return;
    const w = svg.getBoundingClientRect().width;
    if (w === 0 || vbWidth === 0) return;
    const scale = w / vbWidth;
    const rxUser = 6 / scale;
    rect.setAttribute('rx', String(rxUser));
    rect.setAttribute('ry', String(rxUser));
  };
  const observer = new ResizeObserver(() => {
    if (laidOut) { updateRadius(); return; }
    const box = svg.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;

    // Measure each text element's rendered bounding box. Both are
    // currently anchored at (0,0) with text-anchor=middle, so bbox
    // reports the natural width/height of the glyphs in user units.
    if (labelEl) { labelEl.setAttribute('x', '0'); labelEl.setAttribute('y', '0'); }
    if (bodyEl)  { bodyEl.setAttribute('x', '0');  bodyEl.setAttribute('y', '0'); }
    const labelBB = labelEl ? labelEl.getBBox() : { width: 0, height: 0 };
    const bodyBB  = bodyEl  ? bodyEl.getBBox()  : { width: 0, height: 0 };

    const contentW = Math.max(labelBB.width, bodyBB.width);
    const totalW   = contentW + 2 * PAD_X;
    let totalH;
    if (labelEl && bodyEl) {
      totalH = PAD_Y + labelBB.height + GAP + bodyBB.height + PAD_Y;
    } else if (labelEl) {
      totalH = PAD_Y + labelBB.height + PAD_Y;
    } else {
      totalH = PAD_Y + bodyBB.height + PAD_Y;
    }

    const centerX = totalW / 2;
    if (labelEl && bodyEl) {
      labelEl.setAttribute('x', String(centerX));
      labelEl.setAttribute('y', String(PAD_Y));
      bodyEl.setAttribute('x', String(centerX));
      bodyEl.setAttribute('y', String(PAD_Y + labelBB.height + GAP));
    } else if (labelEl) {
      // Label-only: center it vertically inside the card.
      labelEl.setAttribute('x', String(centerX));
      labelEl.setAttribute('y', String((totalH - labelBB.height) / 2));
    } else {
      // Body-only.
      bodyEl.setAttribute('x', String(centerX));
      bodyEl.setAttribute('y', String((totalH - bodyBB.height) / 2));
    }

    rect.setAttribute('width',  String(totalW));
    rect.setAttribute('height', String(totalH));

    // SVG strokes are centered on the path: a 1-unit stroke at the
    // rect's edge places half outside the rect's bounds. Without
    // expanding the viewBox, that outer half gets clipped, most
    // visibly on the top/left edges. Read the computed stroke-width
    // (so any CSS-set value works) and pad the viewBox by half on
    // every side.
    const stroke = parseFloat(getComputedStyle(rect).strokeWidth) || 1;
    const half = stroke / 2;
    vbWidth = totalW + stroke;
    svg.setAttribute('viewBox',
      `${-half} ${-half} ${vbWidth} ${totalH + stroke}`);

    svg.style.visibility = '';

    laidOut = true;
    // Set initial radius for current scale; updateRadius runs again
    // on every subsequent ResizeObserver fire so fullscreen toggles
    // keep the 6 CSS px corner.
    updateRadius();
  });
  observer.observe(svg);

  return svg;
}

// svgProhibitStamp builds a "no entry" symbol (circle with diagonal
// slash) sized to fill its parent. Used as an overlay on top of
// other content, caller is responsible for positioning the parent
// (e.g. position: absolute; inset: 0) and z-index. The shape itself
// stretches to whatever box the parent provides
// (preserveAspectRatio="none"), so it covers the full grid area
// rather than letterboxing as a small square.
//
// Inner classes for CSS targeting:
//   .prohibit-stamp : root <svg>
//   .stamp-ring   : <ellipse> (the circle outline)
//   .stamp-slash  : <line> (the diagonal)
export function svgProhibitStamp() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('prohibit-stamp');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', '0 0 100 100');
  // meet → preserve the circle's 1:1 aspect ratio. The stamp scales
  // to the slot's smaller dimension and centers within the slot, so
  // wide slots get a centered circle (not a stretched ellipse).
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-label', 'Prohibited');

  // Radius leaves room for the (non-scaling-stroke) ring stroke so
  // the outer edge doesn't get clipped by the SVG's viewBox bounds
  // at small render sizes. Slash endpoints stay inside the ring.
  const ring = document.createElementNS(SVG_NS, 'ellipse');
  ring.classList.add('stamp-ring');
  ring.setAttribute('cx', '50');
  ring.setAttribute('cy', '50');
  ring.setAttribute('rx', '42');
  ring.setAttribute('ry', '42');
  svg.appendChild(ring);

  const slash = document.createElementNS(SVG_NS, 'line');
  slash.classList.add('stamp-slash');
  slash.setAttribute('x1', '21');
  slash.setAttribute('y1', '21');
  slash.setAttribute('x2', '79');
  slash.setAttribute('y2', '79');
  svg.appendChild(slash);

  return svg;
}
