import { LIT_URL } from "./LibraryTweaksShared.mjs";
import { openInGlance, showLinkMenu } from "./LibraryTweaksShared.mjs";

const HISTORY_SECTION_URL = "moz-src:///zen/library/sections/ZenLibraryHistorySection.mjs";
const ICON_PREFIX = "page-icon:";

const { html } = ChromeUtils.importESModule(LIT_URL, { global: "current" });
const { ZenLibraryHistorySection } = ChromeUtils.importESModule(HISTORY_SECTION_URL, { global: "current" });

export class ZenLibraryHistoryTweaksSection extends ZenLibraryHistorySection {
  static render(library) {
    return html`
      <zen-library-history-tweaks-section class="zen-library-section" data-section="history" .library=${library}></zen-library-history-tweaks-section>
    `;
  }

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("click", this.#onClick, true);
    this.addEventListener("contextmenu", this.#onContextMenu);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("click", this.#onClick, true);
    this.removeEventListener("contextmenu", this.#onContextMenu);
  }

  #linkOf(target) {
    const row = target?.closest?.(".zen-library-row");
    if (!row || target.closest(".zen-library-row-actions")) return null;
    
    const src = row.querySelector(".zen-library-row-icon")?.getAttribute("src") ?? "";
    const url = src.startsWith(ICON_PREFIX) ? src.slice(ICON_PREFIX.length) : "";
    return url ? { row, url } : null;
  }

  #onClick = event => {
    if (!event.altKey || event.button !== 0) return;
    const link = this.#linkOf(event.target);
    if (!link) return;
    
    event.preventDefault();
    event.stopPropagation();
    openInGlance(link.url, link.row);
  };

  #onContextMenu = event => {
    const link = this.#linkOf(event.target);
    if (link) showLinkMenu(event, link.url, link.row);
  };
}

customElements.define("zen-library-history-tweaks-section", ZenLibraryHistoryTweaksSection);