// ==UserScript==
// @name            LibraryTweaks
// @description     Adds additional features to the zen library
// @version         v1.0
// @author          JustAdumbPrsn
// @include         main
// ==/UserScript==

(() => {
  "use strict";

  if (window.gLibraryTweaks) {
    return;
  }

  const LOG_PREFIX = "[LibraryTweaks]";
  const LIBRARY_ELEMENT = "zen-library";
  const LAST_TAB_PREF = "zen.library.last-tab";
  const SEARCH_SECTION_URL =
    "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
  const LIT_URL = "chrome://global/content/vendor/lit.all.mjs";

  const lazy = {};

  // Loaded into the window global, the same way the native sections load each
  // other, so we share module instances (and therefore classes) with Zen.
  ChromeUtils.defineLazyGetter(lazy, "lit", () =>
    ChromeUtils.importESModule(LIT_URL, { global: "current" })
  );
  ChromeUtils.defineLazyGetter(lazy, "searchSection", () =>
    ChromeUtils.importESModule(SEARCH_SECTION_URL, { global: "current" })
  );

  /**
   * Fluent-style ids with English fallbacks. The mod cannot ship an .ftl file
   * through userChrome, so these only fill in text that Fluent left empty. If
   * a real translation for an id ever exists, it wins.
   */
  const STRINGS = {
    "library-bookmarks-section-title": "Bookmarks",
    "library-bookmarks-search-placeholder": "Search bookmarks",
    "library-bookmarks-empty": "No bookmarks to show",
  };

  // Sections

  let bookmarksSection = null;

  /**
   * Builds the Bookmarks section class on first use. This is deferred because
   * the base class can only be loaded once the Library is actually needed.
   *
   * @returns {typeof import("moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs").ZenLibrarySearchSection}
   */
  function getBookmarksSection() {
    if (bookmarksSection) {
      return bookmarksSection;
    }

    const { html } = lazy.lit;
    const { ZenLibrarySearchSection } = lazy.searchSection;

    class ZenLibraryBookmarksSection extends ZenLibrarySearchSection {
      static id = "bookmarks";
      static label = "library-bookmarks-section-title";

      static render(library) {
        return html`
          <zen-library-bookmarks-section
            class="zen-library-section"
            data-section="bookmarks"
            .library=${library}
          ></zen-library-bookmarks-section>
        `;
      }

      get searchPlaceholderL10nId() {
        return "library-bookmarks-search-placeholder";
      }

      firstUpdated() {
        super.firstUpdated();
        const input = this.querySelector("input[type='search']");
        if (input && !input.placeholder) {
          input.placeholder = STRINGS["library-bookmarks-search-placeholder"];
        }
      }

      onSearchChanged() {
        this.requestUpdate();
      }

      renderItems() {
        return html`
          <div class="zen-library-empty">
            ${STRINGS["library-bookmarks-empty"]}
          </div>
        `;
      }
    }

    if (!customElements.get("zen-library-bookmarks-section")) {
      customElements.define(
        "zen-library-bookmarks-section",
        ZenLibraryBookmarksSection
      );
    }

    bookmarksSection = ZenLibraryBookmarksSection;
    return bookmarksSection;
  }

  /**
   * Sections this mod adds. `placement` positions the sidebar tab relative to
   * a native section id; omitted, the section is appended.
   */
  const SECTIONS = [
    {
      id: "bookmarks",
      placement: { before: "history" },
      resolve: getBookmarksSection,
    },
  ];

  /**
   * Returns a copy of a sections map with one section inserted. The native
   * Library renders its sidebar tabs from the insertion order of this object.
   *
   * @param {object} sections - The current id -> section map
   * @param {{id: string}} Section - The section class to add
   * @param {{before?: string, after?: string}} [placement]
   * @returns {object} The new map
   */
  function withSection(sections, Section, { before, after } = {}) {
    const entries = Object.entries(sections).filter(
      ([id]) => id !== Section.id
    );
    let index = entries.length;
    const anchor = entries.findIndex(([id]) => id === (before ?? after));
    if (anchor !== -1) {
      index = before ? anchor : anchor + 1;
    }
    entries.splice(index, 0, [Section.id, Section]);
    return Object.fromEntries(entries);
  }

  // Mod

  class LibraryTweaks {
    static version = "v1.0";

    #Library = null;
    #originalGetInstance = null;

    async init() {
      this.#Library = await customElements.whenDefined(LIBRARY_ELEMENT);
      this.#hookGetInstance();

      // The Library may already exist if this script loaded late.
      const existing = this.#Library.getInstance(false);
      if (existing) {
        this.#extend(existing);
      }
    }

    destroy() {
      if (this.#Library && this.#originalGetInstance) {
        this.#Library.getInstance = this.#originalGetInstance;
      }
      this.#originalGetInstance = null;
      this.#Library = null;
    }

    /**
     * Wraps the native factory so a Library is extended the moment it is
     * created. This is the earliest safe point: the instance exists and is
     * mounted, but Lit has not rendered it yet, so the first render already
     * includes our sections and no flicker or re-render is needed.
     */
    #hookGetInstance() {
      const mod = this;
      const original = this.#Library.getInstance;
      this.#originalGetInstance = original;

      this.#Library.getInstance = function (createIfMissing = true) {
        const creating = createIfMissing && !this.instance;
        // The native constructor resets this pref to "history" when it does
        // not know the saved section yet, so read it before it can.
        const savedTab = creating
          ? Services.prefs.getStringPref(LAST_TAB_PREF, "")
          : "";
        const library = original.call(this, createIfMissing);
        if (creating && library) {
          mod.#extend(library, savedTab);
        }
        return library;
      };
    }

    /**
     * Adds every registered section to a Library instance. Failures are
     * contained so a bug here can never break the native Library.
     *
     * @param {HTMLElement} library - The zen-library instance
     * @param {string} [savedTab] - The last-used section id before construction
     */
    #extend(library, savedTab = "") {
      try {
        for (const { resolve, placement } of SECTIONS) {
          library.zenLibrarySections = withSection(
            library.zenLibrarySections,
            resolve(),
            placement
          );
        }

        if (
          savedTab &&
          savedTab !== library.activeTab &&
          savedTab in library.zenLibrarySections
        ) {
          library.activeTab = savedTab;
        }

        library.requestUpdate();
        library.updateComplete.then(() => this.#fillTabLabels(library));
      } catch (ex) {
        console.error(LOG_PREFIX, "Failed to extend the Library", ex);
      }
    }

    /**
     * Gives our sidebar tabs their text when Fluent has no message for them.
     */
    #fillTabLabels(library) {
      for (const { resolve } of SECTIONS) {
        const Section = resolve();
        const label = library.querySelector(
          `.zen-library-tab[data-section="${Section.id}"] label`
        );
        if (label && !label.textContent.trim()) {
          label.textContent = STRINGS[Section.label] ?? Section.id;
        }
      }
    }
  }

  const mod = new LibraryTweaks();
  window.gLibraryTweaks = mod;
  mod.init().catch(ex => console.error(LOG_PREFIX, "Failed to initialize", ex));
})();