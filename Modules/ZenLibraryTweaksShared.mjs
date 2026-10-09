export const LIT_URL = "chrome://global/content/vendor/lit.all.mjs";
export const PLACES_CONTEXT_ID = "placesContext";
export const BOOKMARKS_SECTION_ID = "bookmarks";
const GLANCE_ENABLED_PREF = "zen.glance.enabled";

export const STRINGS = {
  "library-bookmarks-section-title": "Bookmarks",
  "library-bookmarks-search-placeholder": "Search bookmarks",
  "library-bookmarks-empty": "No bookmarks to show",
  "library-bookmarks-filter-title": "Filter bookmarks",
  "library-bookmarks-filter-workspace": "Workspace",
  "library-bookmarks-filter-tags": "Tags",
  "library-open-split": "Open in Split View",
  "library-open-glance": "Open in Glance",
};

/**
 * Formats a URL for display by stripping protocols and trailing slashes.
 * @param {string} url 
 * @returns {string} Formatted URL string
 */
export function formatUrl(url) {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

function openInTab(url) {
  window.openTrustedLinkIn(url, "tab");
}

async function carryOn(manager, url, how) {
  const browser = manager.detachedBrowser;
  if (!browser || !browser.permitUnload().permitUnload) return;
  
  const spec = browser.currentURI?.spec;
  const page = spec && spec !== "about:blank" ? spec : url;
  
  if (how === "split") {
    openInSplitView(page);
  } else {
    gBrowser.selectedTab = gBrowser.addTrustedTab(page, {
      userContextId: gBrowser.selectedTab.userContextId || undefined,
    });
  }
  await manager.closeDetachedGlance({ skipPermitUnload: true });
}

function addCarryOnButtons(manager, url) {
  const close = document.querySelector("#zen-glance-detached .zen-glance-sidebar-close");
  const template = document.getElementById("zen-glance-sidebar-template");
  if (!close || !template) return;

  const fresh = template.content.cloneNode(true);
  const buttons = ["open", "split"].flatMap(name => {
    const button = fresh.querySelector(`.zen-glance-sidebar-${name}`);
    if (!button) return [];
    
    button.removeAttribute("command");
    button.addEventListener("command", () =>
      carryOn(manager, url, name === "open" ? "expand" : "split")
    );
    return [button];
  });
  close.after(...buttons);
}

/**
 * Opens a link using Zen's detached Glance overlay.
 * @param {string} url 
 * @param {Element} [row] - Context origin for animation
 * @returns {Promise<boolean>} Success state
 */
export async function openInGlance(url, row) {
  const manager = window.gZenGlanceManager;
  if (!manager?.openDetachedGlance || !Services.prefs.getBoolPref(GLANCE_ENABLED_PREF, true)) {
    openInTab(url);
    return false;
  }

  if (manager.detachedBrowser) {
    await manager.closeDetachedGlance();
    if (manager.detachedBrowser) return false;
  }

  const box = window.windowUtils.getBoundsWithoutFlushing(
    row?.isConnected ? row : document.getElementById("zen-main-app-wrapper")
  );

  let opened = null;
  try {
    const pending = manager.openDetachedGlance({
      url,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
      userContextId: gBrowser.selectedTab.userContextId || undefined,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    addCarryOnButtons(manager, url);
    opened = await pending;
  } catch (ex) {
    console.error("Failed to open the Glance", ex);
  }

  if (!opened) {
    openInTab(url);
    return false;
  }

  const onKeyDown = event => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    manager.closeDetachedGlance();
  };
  window.addEventListener("keydown", onKeyDown, true);

  const swipeManager = window.gZenWorkspaces?._swipeManager;
  const swipeTargets = swipeManager
    ? [gNavToolbox, document.getElementById("zen-main-app-wrapper"), document.querySelector("zen-library")].filter(Boolean)
    : [];
    
  for (const el of swipeTargets) swipeManager.detachWorkspaceSwipeGestures(el);

  opened.closed.then(() => {
    window.removeEventListener("keydown", onKeyDown, true);
    for (const el of swipeTargets) swipeManager.attachWorkspaceSwipeGestures(el);
  });
  
  return true;
}

/**
 * Splits the active tab with the targeted URL.
 * @param {string} url 
 * @returns {boolean} Success state
 */
export function openInSplitView(url) {
  const current = gBrowser.selectedTab;
  const tab = gBrowser.addTrustedTab(url, { inBackground: true });
  const splitter = window.gZenViewSplitter;
  
  if (!tab || !splitter?.splitTabs) {
    if (tab) gBrowser.selectedTab = tab;
    return false;
  }
  
  try {
    splitter.splitTabs([current, tab], undefined, 1);
  } catch (ex) {
    console.error("Failed to split the tabs", ex);
    gBrowser.selectedTab = tab;
    return false;
  }
  return true;
}

export const LINK_ACTIONS = [
  { id: "split", label: STRINGS["library-open-split"], run: url => openInSplitView(url) },
  { id: "glance", label: STRINGS["library-open-glance"], run: (url, row) => openInGlance(url, row) },
];

let menu = null;
let target = null;

/**
 * Initializes and displays the context menu overlay for custom link actions.
 * @param {MouseEvent} event 
 * @param {string} url 
 * @param {Element} row 
 */
export function showLinkMenu(event, url, row) {
  event.preventDefault();
  event.stopPropagation();

  if (!menu) {
    menu = window.MozXULElement.parseXULToFragment(`<menupopup class="zen-library-link-menu"/>`).firstElementChild;
    menu.replaceChildren(
      ...LINK_ACTIONS.map(action => {
        const item = document.createXULElement("menuitem");
        item.dataset.action = action.id;
        item.setAttribute("label", action.label);
        return item;
      })
    );
    
    menu.addEventListener("command", commandEvent => {
      const action = LINK_ACTIONS.find(a => a.id === commandEvent.target.dataset.action);
      if (action && target) action.run(target.url, target.row);
    });
    
    menu.addEventListener("popuphidden", hiddenEvent => {
      if (hiddenEvent.target !== menu) return;
      const marked = target?.row;
      setTimeout(() => marked?.removeAttribute("context-active"), 0);
    });
    document.getElementById("mainPopupSet").appendChild(menu);
  }

  target?.row?.removeAttribute("context-active");
  target = { url, row };
  row?.setAttribute("context-active", "");
  menu.openPopupAtScreen(event.screenX, event.screenY, true, event);
}