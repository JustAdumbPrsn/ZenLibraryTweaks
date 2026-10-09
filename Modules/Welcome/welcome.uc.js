// ==UserScript==
// @name           LibraryTweaks Welcome
// @version        v1.3
// @description    Welcome page for LibraryTweaks
// @author         JustAdumbPrsn
// @include        main
// ==/UserScript==

(function () {
  "use strict";

  if (window.gLibraryTweaksWelcome) {
    return;
  }

  // Only readable while the script is being loaded.
  const kScriptURL = Components.stack.filename;

  // Set it back to false in about:config to see the welcome page again.
  const kSeenPref = "librarytweaks-welcome-seen";
  // Zen turns this off after its welcome; forced on while ours runs.
  const kAboutWelcomePref = "browser.aboutwelcome.enabled";
  const kStageAttribute = "zen-welcome-stage";

  const kVideoURL =
    "chrome://browser/content/zen-videos/welcome-background.mp4";
  const kRepositoryURL =
    "https://github.com/JustAdumbPrsn/ZenLibraryTweaks";
  const kTitleLines = ["Welcome to", "Library Tweaks"];
  const kZenElementsToIgnore = [
    "zen-browser-background",
    "zen-toast-container",
  ];

  const kSpring = { type: "spring", bounce: 0.35, visualDuration: 0.35 };
  const kExit = { duration: 0.12, ease: "easeIn" };
  const kFade = { duration: 0.25, ease: "easeOut" };

  const kNextButton = { label: "Next", primary: true };

  let gPages = null;
  let gClosing = false;
  let gShowing = false;
  let gStyle = null;
  let gPrevAboutWelcome = null;
  let gVideoVisible = true;
  let gVideoAnimation = null;

  const gHiddenElements = new Set();

  function getMotion() {
    return window.gZenUIManager?.motion;
  }

  // Falls back to the end state when Zen's motion library is missing.
  function animate(target, keyframes, options) {
    const motion = getMotion();
    if (motion?.animate) {
      return motion.animate(target, keyframes, options);
    }
    const elements =
      typeof target === "string"
        ? document.querySelectorAll(target)
        : target instanceof Element
          ? [target]
          : target;
    const { opacity } = keyframes;
    if (opacity !== undefined) {
      for (const element of elements) {
        element.style.opacity = Array.isArray(opacity)
          ? opacity.at(-1)
          : opacity;
      }
    }
    return Promise.resolve();
  }

  function stagger(...args) {
    return getMotion()?.stagger?.(...args) ?? 0;
  }

  function parseXUL(xul) {
    return window.MozXULElement.parseXULToFragment(xul);
  }

  function makeEl(className, ...children) {
    const element = document.createElement("div");
    element.className = className;
    element.append(...children);
    return element;
  }

  function makeSvg(tag, attributes = {}, ...children) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    element.append(...children);
    return element;
  }

  function forceAboutWelcomeOn() {
    if (gPrevAboutWelcome !== null) {
      return;
    }
    try {
      gPrevAboutWelcome = Services.prefs.getBoolPref(kAboutWelcomePref, false);
      Services.prefs.setBoolPref(kAboutWelcomePref, true);
      window.addEventListener("unload", restoreAboutWelcome, { once: true });
    } catch (ex) {
      console.error(`Failed to set ${kAboutWelcomePref}`, ex);
    }
  }

  function restoreAboutWelcome() {
    if (gPrevAboutWelcome === null) {
      return;
    }
    try {
      Services.prefs.setBoolPref(kAboutWelcomePref, gPrevAboutWelcome);
    } catch (ex) {
      console.error(`Failed to restore ${kAboutWelcomePref}`, ex);
    }
    gPrevAboutWelcome = null;
  }

  async function loadStylesheet() {
    const url = kScriptURL
      .split(" -> ")
      .pop()
      .split("?")[0]
      .replace(/[^/]*$/, "welcome.css");
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(response.statusText);
      }
      gStyle = document.createElement("style");
      gStyle.textContent = await response.text();
      document.documentElement.appendChild(gStyle);
      return true;
    } catch (ex) {
      console.error(`Failed to load ${url}`, ex);
      return false;
    }
  }

  function clearBrowserElements() {
    for (const element of document.getElementById("browser").children) {
      if (!kZenElementsToIgnore.includes(element.id)) {
        gHiddenElements.add(element);
        element.style.display = "none";
      }
    }
  }

  // Hidden workspace buttons get measured as 0px and shrunk to dots, so
  // measure again once visible.
  function fixWorkspaceIcons() {
    const run = () => {
      document.getElementById("browser")?.getBoundingClientRect();
      window.gZenWorkspaces?.onWindowResize?.();
    };
    run();
    window.requestAnimationFrame(() => window.requestAnimationFrame(run));
  }

  async function restoreBrowserElements() {
    const elements = [...gHiddenElements];
    gHiddenElements.clear();
    for (const element of elements) {
      element.style.opacity = 0;
      element.style.removeProperty("display");
    }
    window.gZenUIManager?.updateTabsToolbar?.();
    fixWorkspaceIcons();
    await animate(elements, { opacity: [0, 1] });
  }

  function initializeWelcome() {
    const XUL = `
      <html:div id="ltw-welcome-root" role="dialog" aria-modal="true">
        <html:video id="ltw-welcome-video" autoplay="" loop="" muted=""
                    disablepictureinpicture="" tabindex="-1"
                    src="${kVideoURL}"></html:video>
        <html:div id="ltw-welcome">
          <html:div id="ltw-welcome-start">
            <html:h1 id="ltw-welcome-title"></html:h1>
            <button class="footer-button primary" id="ltw-welcome-start-button">
            </button>
          </html:div>
          <html:div id="ltw-welcome-pages">
            <html:div id="ltw-welcome-page-sidebar">
              <html:button id="ltw-welcome-back">Back</html:button>
              <html:div id="ltw-welcome-page-sidebar-content"></html:div>
              <html:div id="ltw-welcome-page-sidebar-buttons"></html:div>
            </html:div>
            <html:div id="ltw-welcome-page-content"></html:div>
          </html:div>
        </html:div>
      </html:div>
    `;
    document.getElementById("browser").appendChild(parseXUL(XUL));
    document
      .getElementById("ltw-welcome-video")
      .play()
      .catch(() => {});
  }

  function setVideoVisible(visible) {
    const video = document.getElementById("ltw-welcome-video");
    if (!video || gVideoVisible === visible) {
      return;
    }
    gVideoVisible = visible;
    gVideoAnimation?.stop?.();
    if (visible) {
      video.play().catch(() => {});
    }
    const current = Number(getComputedStyle(video).opacity);
    const run = animate(
      video,
      { opacity: [Number.isNaN(current) ? 0 : current, visible ? 1 : 0] },
      { duration: 0.6, ease: "easeOut" }
    );
    gVideoAnimation = run;
    const settle = () => {
      if (gVideoAnimation !== run || gVideoVisible !== visible) {
        return;
      }
      video.style.opacity = visible ? "1" : "0";
      if (!visible) {
        video.pause();
      }
    };
    run.then(settle, settle);
  }

  async function closeWelcome() {
    if (gClosing) {
      return;
    }
    gClosing = true;
    Services.prefs.setBoolPref(kSeenPref, true);
    restoreAboutWelcome();
    window.removeEventListener("keydown", onKeyDown, true);
    await animate("#ltw-welcome-root", { opacity: [1, 0] });
    document.getElementById("ltw-welcome-video")?.pause();
    gVideoAnimation?.stop?.();
    gVideoAnimation = null;
    gVideoVisible = true;
    document.getElementById("ltw-welcome-root").remove();
    gPages = null;
    gStyle?.remove();
    gStyle = null;
    await restoreBrowserElements();
    gClosing = false;
    gShowing = false;
  }

  // Escape skips the welcome page, so a broken page can never trap the user.
  function onKeyDown(event) {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (gPages) {
      gPages.finish();
    } else {
      closeWelcome();
    }
  }

  function openRepository() {
    try {
      const open = window.openTrustedLinkIn ?? window.openWebLinkIn;
      open(kRepositoryURL, "tab");
    } catch (ex) {
      console.error(`Failed to open ${kRepositoryURL}`, ex);
    }
  }

  function createGitHubIcon() {
    return makeSvg(
      "svg",
      {
        viewBox: "0 0 16 16",
        fill: "currentColor",
        class: "ltw-welcome-button-icon",
      },
      makeSvg("path", {
        d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z",
      })
    );
  }

  class nsZenLibraryTweaksWelcomePages {
    #index = -1;
    #pages;

    constructor(pages) {
      this.#pages = pages;
      this.init();
      this.next();
    }

    get textContainer() {
      return document.getElementById("ltw-welcome-page-sidebar-content");
    }

    get contentContainer() {
      return document.getElementById("ltw-welcome-page-content");
    }

    get buttonsContainer() {
      return document.getElementById("ltw-welcome-page-sidebar-buttons");
    }

    get backButton() {
      return document.getElementById("ltw-welcome-back");
    }

    get currentPage() {
      return this.#pages[this.#index];
    }

    init() {
      document.getElementById("ltw-welcome-start").remove();
      const pages = document.getElementById("ltw-welcome-pages");
      pages.style.display = "flex";
      animate(pages, { opacity: [0, 1] }, { ...kFade, duration: 0.45 });
      this.backButton.addEventListener("click", () => this.back());
    }

    next() {
      this.#show(this.#index + 1, 1);
    }

    back() {
      if (this.#index > 0) {
        this.#show(this.#index - 1, -1);
      }
    }

    #show(index, direction) {
      const previous = this.currentPage;
      while (this.#pages[index]?.skip?.()) {
        index += direction;
      }
      if (index < 0) {
        return;
      }
      const page = this.#pages[index];
      if (!page) {
        // The index stays on the last page so finish() can run its leave().
        this.finish();
        return;
      }
      this.#index = index;
      document
        .getElementById("ltw-welcome-root")
        ?.toggleAttribute("force-light", !!page.forceLight);
      setVideoVisible(!page.gradientBackground);
      previous?.leave?.();
      this.#exit(this.textContainer, { x: [0, -80 * direction] });
      this.#exit(this.contentContainer, {});
      this.backButton.toggleAttribute("disabled", index === 0);
      this.#renderButtons(page);
      this.#renderText(page, direction);
      this.#renderContent(page);
    }

    #exit(container, keyframes) {
      for (const element of container.children) {
        if (element.hasAttribute("exiting")) {
          continue;
        }
        element.setAttribute("exiting", "");
        animate(element, { opacity: [1, 0], ...keyframes }, kExit).then(() =>
          element.remove()
        );
      }
    }

    #renderText(page, direction) {
      const text = makeEl("ltw-welcome-text");
      const title = document.createElement("h1");
      title.textContent = page.title;
      text.append(title);
      for (const description of page.descriptions ?? []) {
        const paragraph = document.createElement("p");
        paragraph.textContent = description;
        text.append(paragraph);
      }
      this.textContainer.append(text);
      animate(
        [...text.children],
        { opacity: [0, 1], x: [120 * direction, 0] },
        { ...kSpring, bounce: 0.4, visualDuration: 0.3, delay: stagger(0.03) }
      );
    }

    #renderContent(page) {
      const content = makeEl("ltw-welcome-page");
      if (page.id) {
        content.setAttribute("page", page.id);
      }
      page.render?.(content);
      this.contentContainer.append(content);
      animate(content, { opacity: [0, 1] }, kFade);
    }

    #renderButtons(page) {
      const fragment = document.createDocumentFragment();
      for (const button of page.buttons ?? [kNextButton]) {
        const element = document.createElement("button");
        element.className = button.primary
          ? "zen-big-accent-button primary"
          : "zen-big-accent-button";
        if (button.icon === "github") {
          element.append(createGitHubIcon(), button.label);
          element.classList.add("ltw-welcome-icon-button");
        } else {
          element.textContent = button.label;
        }
        element.addEventListener("click", () => {
          if (button.onclick?.(this) !== false) {
            this.next();
          }
        });
        fragment.append(element);
      }
      this.buttonsContainer.replaceChildren(fragment);
    }

    async finish() {
      this.currentPage?.leave?.();
      this.buttonsContainer.replaceChildren();
      this.backButton.toggleAttribute("disabled", true);
      await closeWelcome();
    }
  }

  // Buttons default to a single "Next" button.
  function getWelcomePages() {
    return [
      {
        id: "finish",
        title: "You're all set",
        descriptions: [
          "Thanks for installing the mod!",
          "If you like it, make sure to give the repository a star.",
        ],
        gradientBackground: true,
        buttons: [
          {
            label: "Star the repository",
            icon: "github",
            onclick: openRepository,
          },
          { label: "Sweet!", primary: true },
        ],
      },
    ];
  }

  async function animateInitialStage() {
    const title = document.getElementById("ltw-welcome-title");
    for (const line of kTitleLines) {
      const lineElement = document.createElement("span");
      for (const char of line) {
        if (char === " ") {
          lineElement.append(" ");
          continue;
        }
        const charElement = document.createElement("span");
        charElement.className = "ltw-welcome-char";
        charElement.textContent = char;
        lineElement.append(charElement);
      }
      title.append(lineElement);
    }
    await animate(
      title.querySelectorAll(".ltw-welcome-char"),
      { opacity: [0, 1], y: [50, 0] },
      {
        delay: stagger(0.035, { startDelay: 0.8 }),
        type: "spring",
        bounce: 0.3,
        visualDuration: 0.45,
      }
    );
    const button = document.getElementById("ltw-welcome-start-button");
    // The welcome page was skipped while the title was animating.
    if (!button) {
      return;
    }
    button.addEventListener(
      "click",
      async () => {
        await animate(
          "#ltw-welcome-title .ltw-welcome-char, #ltw-welcome-start-button",
          { opacity: [1, 0], y: [0, -14] },
          { duration: 0.3, ease: "easeIn", delay: stagger(0.012) }
        );
        gPages = new nsZenLibraryTweaksWelcomePages(getWelcomePages());
      },
      { once: true }
    );
    await animate(
      button,
      { opacity: [0, 1], y: [20, 0], filter: ["blur(2px)", "blur(0px)"] },
      { delay: 0.1, type: "spring", stiffness: 300, damping: 20, mass: 1.8 }
    );
  }

  async function showWelcome() {
    if (gShowing) {
      return;
    }
    gShowing = true;
    // Without styles the UI would be hidden behind a broken page, so bail out.
    if (!(await loadStylesheet())) {
      gShowing = false;
      return;
    }
    forceAboutWelcomeOn();
    clearBrowserElements();
    initializeWelcome();
    window.addEventListener("keydown", onKeyDown, true);
    animateInitialStage();
  }

  function shouldShowWelcome() {
    return (
      !Services.prefs.getBoolPref(kSeenPref, false) &&
      !window.PrivateBrowsingUtils?.isWindowPrivate(window) &&
      window.toolbar?.visible !== false
    );
  }

  function isShownInOtherWindow() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win !== window && win.gLibraryTweaksWelcome?.showing) {
        return true;
      }
    }
    return false;
  }

  // Zen's own welcome page runs first, ours follows it.
  async function waitForZen() {
    for (let i = 0; i < 40; i++) {
      if (window.gZenUIManager?.motion && window.gZenWorkspaces) {
        await window.gZenWorkspaces.promiseInitialized;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const root = document.documentElement;
    if (!root.hasAttribute(kStageAttribute)) {
      return;
    }
    await new Promise(resolve => {
      const observer = new MutationObserver(() => {
        if (!root.hasAttribute(kStageAttribute)) {
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(root, {
        attributes: true,
        attributeFilter: [kStageAttribute],
      });
    });
  }

  async function startWelcome() {
    if (!shouldShowWelcome()) {
      return;
    }
    await waitForZen();
    // No await between this check and showWelcome() setting gShowing, so
    // only one window can win.
    if (shouldShowWelcome() && !isShownInOtherWindow()) {
      showWelcome();
    }
  }

  window.gLibraryTweaksWelcome = {
    show: showWelcome,
    get showing() {
      return gShowing;
    },
  };
  startWelcome();
})();