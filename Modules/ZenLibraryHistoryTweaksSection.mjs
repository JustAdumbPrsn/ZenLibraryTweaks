/**
 * The History section of the Library: the native one, with the two shortcuts
 * of the history menu above its list. It replaces the native section in the
 * Library, so everything else about it stays as Zen made it.
 */

import { LIT_URL, STRINGS, formatUrl } from "./LibraryTweaksShared.mjs";

const HISTORY_SECTION_URL =
  "moz-src:///zen/library/sections/ZenLibraryHistorySection.mjs";
const PREF_HISTORY_STYLING_DISABLED = "librarytweaks-history-styling-disabled";

// Session store tells this when the closed tabs or windows lists change.
const CLOSED_OBJECTS_TOPIC = "sessionstore-closed-objects-changed";
// What the native recently closed menu reads to decide whose tabs it lists.
const CLOSED_FROM_ALL_WINDOWS_PREF =
  "browser.sessionstore.closedTabsFromAllWindows";
const CLOSED_FROM_CLOSED_WINDOWS_PREF =
  "browser.sessionstore.closedTabsFromClosedWindows";

const { html } = ChromeUtils.importESModule(LIT_URL, { global: "current" });
const { ZenLibraryHistorySection } = ChromeUtils.importESModule(
  HISTORY_SECTION_URL,
  { global: "current" }
);

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils:
    "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SessionWindowUI:
    "moz-src:///browser/components/sessionstore/SessionWindowUI.sys.mjs",
});

const closedAtFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * Checks whether the history styling tweak is disabled via preference.
 * Handles both boolean (false = 0) and integer (0) values.
 */
function isHistoryStylingDisabled() {
  try {
    return Services.prefs.getBoolPref(PREF_HISTORY_STYLING_DISABLED, false);
  } catch {
    try {
      return Services.prefs.getIntPref(PREF_HISTORY_STYLING_DISABLED, 0) !== 0;
    } catch {
      return false;
    }
  }
}

export class ZenLibraryHistoryTweaksSection extends ZenLibraryHistorySection {
  static render(library) {
    return html`
      <zen-library-history-tweaks-section
        class="zen-library-section"
        data-section="history"
        .library=${library}
      ></zen-library-history-tweaks-section>
    `;
  }

  #observer = { observe: () => this.#readClosedTabs() };
  #prefObserver = {
    observe: (subject, topic, data) => {
      if (!data || data === PREF_HISTORY_STYLING_DISABLED) {
        this.#onPrefChanged();
      }
    },
  };

  // What the closed tabs list shows, as `{tab, index, source}`.
  #closedEntries = [];
  #showingClosed = false;

  connectedCallback() {
    super.connectedCallback();
    this.addEventListener("keydown", this.#onKeyDown);
    Services.obs.addObserver(this.#observer, CLOSED_OBJECTS_TOPIC);
    Services.prefs.addObserver(
      PREF_HISTORY_STYLING_DISABLED,
      this.#prefObserver
    );
    if (!isHistoryStylingDisabled()) {
      this.#readClosedTabs();
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener("keydown", this.#onKeyDown);
    Services.obs.removeObserver(this.#observer, CLOSED_OBJECTS_TOPIC);
    Services.prefs.removeObserver(
      PREF_HISTORY_STYLING_DISABLED,
      this.#prefObserver
    );
  }

  #onPrefChanged() {
    if (isHistoryStylingDisabled()) {
      this.#setShowingClosed(false);
      this.removeAttribute("closed-view");
    } else {
      this.#readClosedTabs();
    }
    this.requestUpdate();
  }

  // Reading the closed tabs

  /**
   * Lists the tabs the native menu lists: the ones closed in this window,
   * and by the same prefs in the other open windows and in windows that
   * were closed. Tabs closed along with a folder are listed as plain tabs,
   * and the blank tab Zen keeps in every folder is left out. Each tab keeps
   * the index it has in its own list, which is what restoring and
   * forgetting take.
   *
   * @returns {object[]}
   */
  #buildClosedEntries() {
    const store = window.SessionStore;
    if (!store) {
      return [];
    }
    const prefs = Services.prefs;
    const windows =
      prefs.getBoolPref(CLOSED_FROM_ALL_WINDOWS_PREF, true) &&
      store.getWindows
        ? store.getWindows(window)
        : [window];
    const sets = windows.map(win => store.getClosedTabDataForWindow(win));
    if (
      prefs.getBoolPref(CLOSED_FROM_CLOSED_WINDOWS_PREF, true) &&
      !lazy.PrivateBrowsingUtils.isWindowPrivate(window) &&
      store.getClosedTabCountFromClosedWindows?.()
    ) {
      sets.push(store.getClosedTabDataFromClosedWindows());
    }

    const entries = [];
    for (const set of sets) {
      set.forEach((tab, index) => {
        if (!this.#isFolderPlaceholder(tab)) {
          entries.push({ tab, index, source: tab });
        }
      });
    }
    return entries;
  }

  #readClosedTabs() {
    if (isHistoryStylingDisabled()) {
      return;
    }
    try {
      this.#closedEntries = this.#buildClosedEntries();
    } catch (ex) {
      console.error("Failed to read the closed tabs", ex);
      this.#closedEntries = [];
    }
    // Nothing left to show, so the list has no reason to stay open.
    if (!this.#closedEntries.length) {
      this.#setShowingClosed(false);
    }
    this.requestUpdate();
  }

  /**
   * Slides between the history and the closed tabs. The sliding itself
   * is a transition on the `closed-view` attribute in the CSS.
   *
   * @param {boolean} showing
   */
  #setShowingClosed(showing) {
    if (this.#showingClosed === showing) {
      return;
    }
    this.#showingClosed = showing;
    this.toggleAttribute("closed-view", showing);
    this.requestUpdate();
    // Inert panes cannot take focus, so this waits for the update.
    this.updateComplete.then(() =>
      this.querySelector(
        showing ? ".zen-library-closed-back" : ".zen-library-closed-shortcut"
      )?.focus()
    );
  }

  #onKeyDown = event => {
    if (isHistoryStylingDisabled()) {
      return;
    }
    if (event.key === "Escape" && this.#showingClosed) {
      // Goes back a step instead of closing the Library.
      event.preventDefault();
      event.stopPropagation();
      this.#setShowingClosed(false);
    }
  };

  // Closed tabs

  /**
   * @param {object} data - A closed tab or folder, or the tab it came with
   * @returns {object} What session store takes to find where it was closed:
   *   a window that is gone, or one that is still open
   */
  #sourceOf(data) {
    return typeof data.sourceClosedId === "number"
      ? { sourceClosedId: data.sourceClosedId }
      : { sourceWindowId: data.sourceWindowId };
  }

  /**
   * @param {object} closedTab - An entry of the session store's list
   * @returns {{title: string, url: string}} What the row shows: the page
   *   the tab was on when it closed
   */
  #closedTabInfo(closedTab) {
    const { entries = [], index = entries.length } = closedTab.state ?? {};
    const entry = entries[index - 1] ?? entries.at(-1);
    const url = entry?.url ?? "";
    return { url, title: closedTab.title || entry?.title || url };
  }

  /**
   * Zen keeps a blank pinned tab in every folder to hold its place. It
   * is not something to list. A blank tab that was not in a folder is a
   * real tab, so it stays.
   *
   * @param {object} closedTab
   * @returns {boolean}
   */
  #isFolderPlaceholder(closedTab) {
    const entries = closedTab?.state?.entries ?? [];
    return (
      !!closedTab?.closedInTabGroupId &&
      !!entries.length &&
      entries.every(({ url }) => url === "about:blank")
    );
  }

  #undoTab({ tab, index, source }) {
    const store = window.SessionStore;
    if (typeof source.sourceClosedId === "number") {
      const undo =
        store.undoClosedTabFromClosedWindow ??
        store.undoCloseTabFromClosedWindow;
      undo.call(store, this.#sourceOf(source), tab.closedId);
    } else if (typeof window.undoCloseTab === "function") {
      window.undoCloseTab(index, source.sourceWindowId);
    } else {
      lazy.SessionWindowUI.undoCloseTab(
        window,
        index,
        source.sourceWindowId
      );
    }
  }

  #forgetTab({ tab, index, source }) {
    const store = window.SessionStore;
    try {
      if (store.forgetClosedTabById) {
        store.forgetClosedTabById(tab.closedId, this.#sourceOf(source));
      } else {
        store.forgetClosedTab(window, index);
      }
    } catch (ex) {
      console.error("Failed to forget the closed tab", ex);
    }
    this.#readClosedTabs();
  }

  #reopen(restore, event) {
    const background =
      !!event && (event.getModifierState("Accel") || event.button === 1);
    if (!background) {
      try {
        restore();
      } catch (ex) {
        console.error("Failed to restore", ex);
        return;
      }
      this.library?.constructor.toggle();
      return;
    }
    let restored = false;
    this.library.keepOpenWhile(() => {
      const previous = gBrowser.selectedTab;
      try {
        restore();
        restored = true;
      } catch (ex) {
        console.error("Failed to restore", ex);
      }
      if (previous?.isConnected) {
        gBrowser.selectedTab = previous;
      }
    });
    if (restored) {
      gZenUIManager.showToast("library-history-opened-in-background");
    }
  }

  #onDragStart(event, title, url) {
    if (!url) {
      event.preventDefault();
      return;
    }
    const { dataTransfer } = event;
    dataTransfer.setData("text/x-moz-url", `${url}\n${title}`);
    dataTransfer.setData("text/uri-list", url);
    dataTransfer.setData("text/plain", url);
    dataTransfer.effectAllowed = "copyLink";
    dataTransfer.addElement(event.currentTarget);
    // eslint-disable-next-line mozilla/valid-services
    Services.zen.playHapticFeedback();
  }

  #clearHistory() {
    document.getElementById("Tools:Sanitize")?.doCommand();
  }

  // Rendering

  #onActivateKey(event, onActivate) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate(event);
    }
  }

  #renderShortcut({
    icon,
    text,
    className = "",
    disabled = false,
    chevron = false,
    onActivate,
  }) {
    return html`
      <div
        class="zen-library-row zen-library-shortcut ${className}"
        role="button"
        tabindex=${disabled ? -1 : 0}
        ?disabled=${disabled}
        @click=${onActivate}
        @keydown=${event => this.#onActivateKey(event, onActivate)}
      >
        <img class="zen-library-row-icon" src=${icon} alt="" />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${text}</span>
        </div>
        ${chevron
          ? html`<img
              class="zen-library-shortcut-chevron"
              src="chrome://global/skin/icons/arrow-right.svg"
              alt=""
            />`
          : null}
      </div>
    `;
  }

  #renderRowActions(onForget, onReopen) {
    return html`
      <div class="zen-library-row-actions">
        <toolbarbutton
          class="toolbarbutton-1"
          data-l10n-id="library-history-forget-button"
          @click=${event => {
            event.stopPropagation();
            onForget();
          }}
        >
          <img
            class="toolbarbutton-icon"
            src="chrome://browser/skin/zen-icons/trash.svg"
            alt=""
          />
        </toolbarbutton>
        <toolbarbutton
          class="toolbarbutton-1"
          data-l10n-id="library-history-reopen-button"
          @click=${event => {
            event.stopPropagation();
            onReopen(event);
          }}
        >
          <img
            class="toolbarbutton-icon"
            src="chrome://browser/skin/zen-icons/u-turn-to-left.svg"
            alt=""
          />
        </toolbarbutton>
      </div>
    `;
  }

  #renderClosedTab(item) {
    const { tab, source } = item;
    const { title, url } = this.#closedTabInfo(tab);
    const closedAt = tab.closedAt ?? source.closedAt;
    const reopen = event => this.#reopen(() => this.#undoTab(item), event);
    return html`
      <div
        class="zen-library-row"
        role="button"
        tabindex="0"
        draggable="true"
        @click=${reopen}
        @auxclick=${event => {
          if (event.button === 1) {
            event.preventDefault();
            reopen(event);
          }
        }}
        @keydown=${event => this.#onActivateKey(event, reopen)}
        @dragstart=${event => this.#onDragStart(event, title, url)}
      >
        <img class="zen-library-row-icon" src="page-icon:${url}" alt="" />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${title}</span>
          <span class="zen-library-row-subtitle"
            >${closedAt
              ? html`<span class="zen-library-visit-url"
                    >${formatUrl(url)}</span
                  ><span class="zen-library-visit-date"
                    >${closedAtFormat.format(closedAt)}</span
                  >`
              : formatUrl(url)}</span
          >
        </div>
        ${this.#renderRowActions(() => this.#forgetTab(item), reopen)}
      </div>
    `;
  }

  #renderClosedPane() {
    const back = () => this.#setShowingClosed(false);
    return html`
      <div
        class="zen-library-pane zen-library-closed-pane"
        ?inert=${!this.#showingClosed}
      >
        <div class="zen-library-closed-header">
          <div
            class="zen-library-row zen-library-closed-back"
            role="button"
            tabindex="0"
            aria-label=${STRINGS["library-history-back"]}
            @click=${back}
            @keydown=${event => this.#onActivateKey(event, back)}
          >
            <img
              class="zen-library-row-icon"
              src="chrome://global/skin/icons/arrow-left.svg"
              alt=""
            />
            <div class="zen-library-row-text">
              <span class="zen-library-row-title"
                >${STRINGS["library-history-closed-tabs"]}</span
              >
            </div>
          </div>
        </div>
        <div class="zen-library-closed-list">
          ${this.#closedEntries.length
            ? html`<div class="zen-library-group">
                ${this.#closedEntries.map(entry =>
                  this.#renderClosedTab(entry)
                )}
              </div>`
            : html`<div class="zen-library-empty">
                ${STRINGS["library-history-closed-tabs-empty"]}
              </div>`}
        </div>
      </div>
    `;
  }

  renderItems() {
    const items = super.renderItems();
    if (isHistoryStylingDisabled() || this.searchQuery) {
      return items;
    }
    return html`
      <div class="zen-library-group">
        ${this.#renderShortcut({
          icon: "chrome://browser/skin/zen-icons/u-turn-to-left.svg",
          text: STRINGS["library-history-closed-tabs"],
          className: "zen-library-closed-shortcut",
          disabled: !this.#closedEntries.length,
          chevron: true,
          onActivate: () => this.#setShowingClosed(true),
        })}
        ${this.#renderShortcut({
          icon: "chrome://browser/skin/zen-icons/trash.svg",
          text: STRINGS["library-history-clear"],
          onActivate: () => this.#clearHistory(),
        })}
      </div>
      ${items}
    `;
  }

  render() {
    if (isHistoryStylingDisabled()) {
      return super.render();
    }
    return html`
      <div class="zen-library-pane-track">
        <div
          class="zen-library-pane zen-library-history-pane"
          ?inert=${this.#showingClosed}
        >
          ${super.render()}
        </div>
        ${this.#renderClosedPane()}
      </div>
    `;
  }
}

customElements.define(
  "zen-library-history-tweaks-section",
  ZenLibraryHistoryTweaksSection
);