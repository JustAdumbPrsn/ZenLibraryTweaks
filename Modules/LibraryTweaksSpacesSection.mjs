/**
 * Tweaks for the native Spaces section.
 *
 * Drop slot: while a space is dragged, the others shift aside with
 * `shift="left|right"`. A dashed box is placed in the gap they leave, with the
 * size of the dragged space.
 */

const SPACE = ".zen-library-space";
const SPACES = ".zen-library-spaces";
const SLOT_CLASS = "zen-library-space-drop-slot";

const observers = new WeakMap();

/**
 * Places, moves or removes the drop slot to match the current drag state.
 *
 * `offsetLeft` ignores `translate`, so it is the dragged space's original
 * position. Each space shifted left means the slot is one step further right,
 * each one shifted right means one step further left.
 *
 * @param {Element} library
 */
function updateDropSlot(library) {
  const container = library.querySelector(SPACES);
  if (!container) {
    return;
  }

  const dragged = container.querySelector(`${SPACE}[dragging]`);
  let slot = container.querySelector(`:scope > .${SLOT_CLASS}`);

  if (!dragged) {
    slot?.remove();
    return;
  }

  const gap = parseFloat(getComputedStyle(container).columnGap) || 0;
  const step = dragged.offsetWidth + gap;

  let offset = 0;
  for (const space of container.querySelectorAll(`${SPACE}[shift]`)) {
    if (space !== dragged) {
      offset += space.getAttribute("shift") === "left" ? 1 : -1;
    }
  }

  const isNew = !slot;
  if (isNew) {
    slot = document.createElement("div");
    slot.className = SLOT_CLASS;
    slot.inert = true;
    // Appended rather than prepended so index-based child lookups still work.
    container.append(slot);
    slot.style.transition = "none";
  }

  slot.style.left = `${dragged.offsetLeft + offset * step}px`;
  slot.style.top = `${dragged.offsetTop}px`;
  slot.style.width = `${dragged.offsetWidth}px`;
  slot.style.height = `${dragged.offsetHeight}px`;

  if (isNew) {
    // Commit the starting position so only later moves animate.
    void slot.offsetWidth;
    slot.style.transition = "";
  }
}

/**
 * Starts watching a Library instance for space drags. Safe to call again.
 * The observer is on the Library itself so it survives the Spaces container
 * being re-rendered.
 *
 * @param {Element} library
 */
export function hookSpacesSection(library) {
  if (!library || observers.has(library)) {
    return;
  }

  const observer = new MutationObserver(() => updateDropSlot(library));
  observer.observe(library, {
    attributes: true,
    subtree: true,
    attributeFilter: ["dragging", "shift"],
  });
  observers.set(library, observer);
}

/**
 * Stops watching a Library instance and removes any leftover slot.
 *
 * @param {Element} library
 */
export function unhookSpacesSection(library) {
  observers.get(library)?.disconnect();
  observers.delete(library);
  library?.querySelector(`${SPACES} > .${SLOT_CLASS}`)?.remove();
}
