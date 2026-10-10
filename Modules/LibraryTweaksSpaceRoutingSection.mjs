import { LIT_URL, STRINGS } from "./LibraryTweaksShared.mjs";

const SEARCH_SECTION_URL = "moz-src:///zen/library/sections/ZenLibrarySearchSection.mjs";
const { html, nothing, repeat } = ChromeUtils.importESModule(LIT_URL, { global: "current" });
const { ZenLibrarySearchSection } = ChromeUtils.importESModule(SEARCH_SECTION_URL, { global: "current" });

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  gZenSpaceRoutingManager: "resource:///modules/zen/spacerouting/ZenSpaceRoutingManager.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

const WORKSPACE_EVENTS = ["ZenWorkspaceDataChanged", "ZenWorkspacesUIUpdate"];
const MOST_RECENT_SPACE = "most-recent-space";
const MATCH_TYPES = ["contains", "equal-to", "regex"];
const LINK_ICON = "chrome://browser/skin/zen-icons/link.svg";

const ICONS = {
  remove: "chrome://browser/skin/zen-icons/trash.svg",
  arrow: "chrome://browser/skin/zen-icons/arrow-corner-down-right.svg",
  chevron: "chrome://global/skin/icons/arrow-down-12.svg",
};

const TEXT = {
  "library-space-routing": "Routing",
  "library-space-routing-search-placeholder": "Search routes",
  "library-space-routing-filter-title": "Filter routes",
  "library-space-routing-new": "New",
  "library-space-routing-routes": "Routes",
  "library-space-routing-external": "Links from other apps (Mail, Slack…)",
  "library-space-routing-empty": "No routes yet. Add one to open a site in a space every time, like work sites in Work.",
  "library-space-routing-no-results": "No routes match your search.",
  "library-space-routing-new-title": "New route",
  "library-space-routing-edit-title": "Edit route",
  "library-space-routing-when": "When the link",
  "library-space-routing-open-in": "Open it in",
  "library-space-routing-add": "Add route",
  "library-space-routing-most-recent": "Most recent space",
  "library-space-routing-missing": "Space was deleted",
  "library-space-routing-remove": "Remove route",
  "library-space-routing-save": "Save",
  "library-space-routing-cancel": "Cancel",
  "library-space-routing-contains": "Contains",
  "library-space-routing-equal-to": "Is Exactly",
  "library-space-routing-regex": "RegEx",
  "library-space-routing-invalid": "Invalid RegEx",
};

if (Object.isExtensible(STRINGS)) Object.assign(STRINGS, TEXT);

export class ZenLibrarySpaceRoutingSection extends ZenLibrarySearchSection {
  static id = "space-routing";
  static label = "library-space-routing";

  static render(library) {
    return html`<zen-library-space-routing-section class="zen-library-section" data-section="space-routing" .library=${library}></zen-library-space-routing-section>`;
  }

  static properties = {
    routes: { state: true },
    external: { state: true },
    editing: { state: true },
  };

  #spaces = [];
  #favicons = new Map();
  #spaceMenu = null;
  #onSpacePicked = null;

  constructor() {
    super();
    this.routes = [];
    this.external = MOST_RECENT_SPACE;
    this.editing = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.#refresh();
    for (const type of WORKSPACE_EVENTS) window.addEventListener(type, this.#refresh);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#spaceMenu?.remove();
    this.#spaceMenu = null;
    for (const type of WORKSPACE_EVENTS) window.removeEventListener(type, this.#refresh);
  }

  get searchPlaceholderL10nId() { return "library-space-routing-search-placeholder"; }
  get filterTitleL10nId() { return "library-space-routing-filter-title"; }

  onShown() {
    super.onShown?.();
    this.#refresh();
  }

  onHidden() {
    super.onHidden?.();
    this.#closeEditor();
  }

  onLibraryClosing() {
    super.onLibraryClosing?.();
    this.#closeEditor();
  }

  #closeEditor() {
    this.#spaceMenu?.hidePopup();
    this.editing = null;
  }

  onSearchChanged() { this.requestUpdate(); }

  updated(changedProperties) {
    this.#ensureNewRouteButton();
    this.#applyStrings();
    super.updated(changedProperties);
  }

  #ensureNewRouteButton() {
    const header = this.querySelector(".zen-library-search-header");
    if (!header || header.querySelector(".zen-library-route-new")) return;
    
    const button = document.createElement("button");
    button.className = "zen-library-filter-button zen-library-route-new";
    button.setAttribute("data-l10n-id", "library-space-routing-new");
    button.addEventListener("click", () => this.#startEditing());
    header.append(button);
  }

  #applyStrings() {
    for (const element of this.querySelectorAll("[data-l10n-id]")) {
      const text = STRINGS[element.getAttribute("data-l10n-id")];
      if (text === undefined) continue;
      if (element.localName === "input") element.placeholder = text;
      else if (element.textContent !== text) element.textContent = text;
    }
  }

  #refresh = () => {
    const manager = lazy.gZenSpaceRoutingManager;
    this.#spaces = window.gZenWorkspaces?.getWorkspaces() ?? [];
    this.external = manager.getDefaultExternalRoute();
    this.routes = manager.getAllRoutes();
  };

  #spaceName(id) {
    if (id === MOST_RECENT_SPACE) return STRINGS["library-space-routing-most-recent"];
    return this.#spaces.find(space => space.uuid === id)?.name ?? STRINGS["library-space-routing-missing"];
  }

  #spaceExists(id) {
    return id === MOST_RECENT_SPACE || this.#spaces.some(space => space.uuid === id);
  }

  #iconFor({ reference, matchType }) {
    if (matchType !== "regex") {
      try {
        const { hostname } = new URL(reference.includes("://") ? reference : `https://${reference}`);
        if (hostname.includes(".") && this.#hasFavicon(hostname)) {
          return `page-icon:https://${hostname}`;
        }
      } catch {}
    }
    return LINK_ICON;
  }

  /**
   * Whether Places knows a favicon for the host. The first call starts the
   * lookup and answers false; the row re-renders once an icon turns up.
   *
   * @param {string} hostname - The host to look up
   * @returns {boolean} True if a favicon is known
   */
  #hasFavicon(hostname) {
    if (!this.#favicons.has(hostname)) {
      this.#favicons.set(hostname, false);
      lazy.PlacesUtils.favicons
        .getFaviconForPage(Services.io.newURI(`https://${hostname}`))
        .then(
          icon => {
            if (icon) {
              this.#favicons.set(hostname, true);
              this.requestUpdate();
            }
          },
          () => {}
        );
    }
    return this.#favicons.get(hostname);
  }

  /**
   * The input placeholder for a match type, as in the native dialog.
   *
   * @param {string} matchType - "contains", "equal-to" or "regex"
   * @returns {string} The placeholder text
   */
  #placeholderFor(matchType) {
    return matchType === "regex" ? "zen-browser\\.app" : "zen-browser.app";
  }

  #visibleRoutes() {
    const query = this.searchQuery?.trim().toLowerCase();
    return this.routes.filter(route =>
      route.reference.trim() &&
      (!query || route.reference.toLowerCase().includes(query) || this.#spaceName(route.openIn).toLowerCase().includes(query))
    );
  }

  #startEditing(route) {
    if (route) {
      this.editing = { ...route, isNew: false };
    } else {
      let host = "";
      try {
        const { currentURI } = window.gBrowser.selectedBrowser;
        host = currentURI.schemeIs("http") || currentURI.schemeIs("https") ? currentURI.host : "";
      } catch {}
      this.editing = {
        id: crypto.randomUUID(),
        reference: host, matchType: "contains",
        openIn: window.gZenWorkspaces?.activeWorkspace ?? MOST_RECENT_SPACE,
        isNew: true,
      };
    }
    this.updateComplete.then(() => {
      const input = this.querySelector(".zen-library-route-input");
      input?.focus();
      input?.select();
      this.querySelector(".zen-library-route-editor")?.scrollIntoView({ block: "nearest" });
    });
  }

  #update(changes) { this.editing = { ...this.editing, ...changes }; }

  #regexError({ reference, matchType }) {
    if (matchType !== "regex" || !reference.trim()) return "";
    try { new RegExp(reference); } catch (ex) { return ex.message; }
    return "";
  }

  #isValid(route) { return !!route.reference.trim() && !this.#regexError(route); }

  #save() {
    if (!this.editing || !this.#isValid(this.editing)) return;
    
    const manager = lazy.gZenSpaceRoutingManager;
    const { isNew, id, reference, matchType, openIn } = this.editing;
    const base = isNew ? manager.createNewRoute() : { id };
    
    manager.updateRoute({ ...base, reference: reference.trim(), matchType, openIn });
    manager.saveRoutes();
    this.editing = null;
    this.#refresh();
  }

  #remove(id) {
    const manager = lazy.gZenSpaceRoutingManager;
    manager.removeRoute(id);
    manager.saveRoutes();
    this.editing = null;
    this.#refresh();
  }

  #setExternal(value) {
    const manager = lazy.gZenSpaceRoutingManager;
    manager.setDefaultExternalRoute(value);
    manager.saveRoutes();
    this.external = value;
  }

  #onEditorKeyDown(event) {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.editing = null;
    } else if (event.key === "Enter" && event.target.localName === "input") {
      this.#save();
    }
  }

  #renderSpaceIcon(id) {
    const icon = this.#spaces.find(space => space.uuid === id)?.icon;
    if (!icon) return nothing;
    return icon.startsWith("chrome://")
      ? html`<img class="zen-library-route-space-icon" src=${icon} alt="" />`
      : html`<span class="zen-library-route-space-icon">${icon}</span>`;
  }

  #renderChips(options, selected, onPick) {
    return html`
      <div class="zen-library-filter-options">
        ${options.map(({ id, label }) => html`
          <div class="zen-library-filter-chip" role="button" tabindex="0" ?active=${selected === id}
            @click=${() => onPick(id)}
            @keydown=${event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPick(id); } }}>
            <span>${label}</span>
          </div>
        `)}
      </div>
    `;
  }

  #renderSpaceMenu(selected, onPick) {
    const id = this.#spaceExists(selected) ? selected : MOST_RECENT_SPACE;
    return html`
      <button class="zen-library-filter-button zen-library-route-select" aria-haspopup="menu"
        @click=${event => this.#openSpaceMenu(event.currentTarget, onPick)}>
        ${this.#renderSpaceIcon(id)}
        <span class="zen-library-route-select-label">${this.#spaceName(id)}</span>
        <img class="zen-library-route-select-chevron" src=${ICONS.chevron} alt="" />
      </button>
    `;
  }

  #openSpaceMenu(anchor, onPick) {
    if (!this.#spaceMenu) {
      this.#spaceMenu = window.MozXULElement.parseXULToFragment(`<menupopup class="zen-library-route-menu"/>`).firstElementChild;
      this.#spaceMenu.addEventListener("command", event => this.#onSpacePicked?.(event.target.value));
      document.getElementById("mainPopupSet").appendChild(this.#spaceMenu);
    }
    this.#onSpacePicked = onPick;
    this.#spaceMenu.replaceChildren(
      this.#createSpaceItem(MOST_RECENT_SPACE, STRINGS["library-space-routing-most-recent"]),
      document.createXULElement("menuseparator"),
      ...this.#spaces.map(({ uuid, name, icon }) => this.#createSpaceItem(uuid, name, icon))
    );
    this.#spaceMenu.style.minWidth = `${anchor.getBoundingClientRect().width}px`;
    this.#spaceMenu.openPopup(anchor, "after_start", 0, 4);
  }

  #createSpaceItem(id, name, icon) {
    const item = document.createXULElement("menuitem");
    item.setAttribute("value", id);
    if (icon?.startsWith("chrome://")) {
      item.className = "menuitem-iconic";
      item.setAttribute("image", icon);
      item.setAttribute("label", name);
    } else {
      item.setAttribute("label", icon ? `${icon} ${name}` : name);
    }
    return item;
  }

  #renderRoute(route) {
    const spaceName = this.#spaceName(route.openIn);
    const icon = this.#iconFor(route);
    return html`
      <div class="zen-library-row" role="button" tabindex="0" ?missing=${!this.#spaceExists(route.openIn)}
        @click=${() => this.#startEditing(route)}
        @keydown=${event => { if (event.target === event.currentTarget && event.key === "Enter") this.#startEditing(route); }}>
        <img class="zen-library-row-icon" ?symbolic=${icon === LINK_ICON} src=${icon} alt="" />
        <div class="zen-library-row-text">
          <span class="zen-library-row-title">${route.reference}</span>
          <span class="zen-library-row-subtitle"><img class="zen-library-route-arrow" src=${ICONS.arrow} alt="" />${this.#renderSpaceIcon(route.openIn)}${spaceName}</span>
        </div>
        <div class="zen-library-row-actions">
          <toolbarbutton class="toolbarbutton-1 zen-library-route-kind">
            <span class="zen-library-route-kind-label">${STRINGS[`library-space-routing-${route.matchType}`]}</span>
          </toolbarbutton>
          <toolbarbutton class="toolbarbutton-1" tooltiptext=${STRINGS["library-space-routing-remove"]}
            @click=${event => { event.stopPropagation(); this.#remove(route.id); }}
            @auxclick=${event => event.stopPropagation()}>
            <img class="toolbarbutton-icon" src=${ICONS.remove} alt="" />
          </toolbarbutton>
        </div>
      </div>
    `;
  }

  #renderEditor() {
    const edit = this.editing;
    const error = this.#regexError(edit);
    return html`
      <div class="zen-library-route-editor" @keydown=${event => this.#onEditorKeyDown(event)}>
        <h4 data-l10n-id=${edit.isNew ? "library-space-routing-new-title" : "library-space-routing-edit-title"}></h4>
        <div class="zen-library-route-field">
          <label data-l10n-id="library-space-routing-when"></label>
          ${this.#renderChips(MATCH_TYPES.map(id => ({ id, label: STRINGS[`library-space-routing-${id}`] })), edit.matchType, matchType => this.#update({ matchType }))}
          <input class="zen-library-route-input" ?invalid=${!!error} aria-invalid=${error ? "true" : nothing} type="text" spellcheck="false" placeholder=${this.#placeholderFor(edit.matchType)} .value=${edit.reference} @input=${event => this.#update({ reference: event.target.value })} />
          ${error ? html`<div class="zen-library-route-error" role="alert">${STRINGS["library-space-routing-invalid"]}: ${error}</div>` : nothing}
        </div>
        <div class="zen-library-route-field">
          <label data-l10n-id="library-space-routing-open-in"></label>
          ${this.#renderSpaceMenu(edit.openIn, openIn => this.#update({ openIn }))}
        </div>
        <div class="zen-library-route-buttons">
          <button data-l10n-id="library-space-routing-cancel" @click=${() => { this.editing = null; }}></button>
          <button primary data-l10n-id=${edit.isNew ? "library-space-routing-add" : "library-space-routing-save"} ?disabled=${!this.#isValid(edit)} @click=${() => this.#save()}></button>
        </div>
      </div>
    `;
  }

  #renderExternal() {
    return html`
      <div class="zen-library-group zen-library-route-external">
        <h3 data-l10n-id="library-space-routing-external"></h3>
        ${this.#renderSpaceMenu(this.external, id => this.#setExternal(id))}
      </div>
    `;
  }

  renderItems() {
    const searching = !!this.searchQuery?.trim();
    const routes = this.#visibleRoutes();
    return html`
      <div class="zen-library-group">
        <h3 data-l10n-id="library-space-routing-routes"></h3>
        ${this.editing?.isNew ? this.#renderEditor() : nothing}
        ${repeat(routes, route => route.id, route => route.id === this.editing?.id ? this.#renderEditor() : this.#renderRoute(route))}
        ${!routes.length && !this.editing && searching ? html`<div class="zen-library-empty" data-l10n-id="library-space-routing-no-results"></div>` : nothing}
        ${!routes.length && !this.editing && !searching ? html`<div class="zen-library-empty" data-l10n-id="library-space-routing-empty"></div>` : nothing}
      </div>
      ${searching ? nothing : this.#renderExternal()}
    `;
  }
}

customElements.define("zen-library-space-routing-section", ZenLibrarySpaceRoutingSection);