document.documentElement.classList.add("has-js");

function setupNavigation() {
  const nav = document.querySelector("[data-nav]");
  const toggle = document.querySelector("[data-menu-toggle]");
  const panel = document.querySelector("[data-menu-panel]");
  if (!nav || !toggle || !panel) return;

  const close = () => {
    toggle.setAttribute("aria-expanded", "false");
    panel.classList.remove("is-open");
  };

  toggle.addEventListener("click", () => {
    const open = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", open ? "false" : "true");
    panel.classList.toggle("is-open", !open);
  });

  panel.addEventListener("click", (event) => {
    if (event.target.closest("a")) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || toggle.getAttribute("aria-expanded") !== "true") return;
    close();
    toggle.focus();
  });

  const updateNav = () => nav.classList.toggle("is-scrolled", window.scrollY > 24);
  updateNav();
  window.addEventListener("scroll", updateNav, { passive: true });
}

function setupReveal() {
  const items = [...document.querySelectorAll(".lp-reveal")];
  if (items.length === 0) return;

  if (!("IntersectionObserver" in window)) {
    for (const item of items) item.classList.add("is-visible");
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );

  for (const item of items) observer.observe(item);
}

function setupDeviceDeck() {
  const deck = document.querySelector("[data-device-deck]");
  if (!deck) return;

  const tabs = [...deck.querySelectorAll("[data-device-tab]")];
  const panels = [...deck.querySelectorAll("[data-device-panel]")];
  const index = deck.querySelector("[data-deck-index]");
  const pauseButton = deck.querySelector("[data-deck-toggle]");
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let current = 0;
  let timer = 0;
  let paused = false;
  let userPaused = reducedMotion.matches;
  let motionOverride = false;
  let inViewport = true;
  const motionAllowed = () => !reducedMotion.matches || motionOverride;

  const syncPauseControl = () => {
    if (!pauseButton) return;
    pauseButton.setAttribute("aria-pressed", userPaused ? "true" : "false");
    pauseButton.textContent = userPaused ? "Play" : "Pause";
  };

  const syncVideo = (panel, active) => {
    const video = panel.querySelector("video");
    if (!video) return;
    if (active && inViewport && !userPaused && motionAllowed() && !document.hidden) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const select = (next, moveFocus = false) => {
    current = (next + panels.length) % panels.length;
    for (const [panelIndex, panel] of panels.entries()) {
      const active = panelIndex === current;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
      panel.setAttribute("aria-hidden", active ? "false" : "true");
      syncVideo(panel, active);
    }
    for (const [tabIndex, tab] of tabs.entries()) {
      const active = tabIndex === current;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
    }
    if (index) index.textContent = String(current + 1).padStart(2, "0");
    if (moveFocus) tabs[current]?.focus();
  };

  const stop = () => {
    if (timer) window.clearInterval(timer);
    timer = 0;
  };

  const start = () => {
    stop();
    if (!inViewport || paused || userPaused || !motionAllowed() || document.hidden) return;
    timer = window.setInterval(() => select(current + 1), 5600);
  };

  pauseButton?.addEventListener("click", () => {
    userPaused = !userPaused;
    motionOverride = reducedMotion.matches && !userPaused;
    if (!userPaused) paused = false;
    syncPauseControl();
    select(current);
    start();
  });

  for (const [tabIndex, tab] of tabs.entries()) {
    tab.addEventListener("click", () => {
      select(tabIndex);
      start();
    });
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") select(0, true);
      else if (event.key === "End") select(tabs.length - 1, true);
      else select(current + (event.key === "ArrowRight" ? 1 : -1), true);
      start();
    });
  }

  deck.addEventListener("mouseenter", () => {
    paused = true;
    stop();
  });
  deck.addEventListener("mouseleave", () => {
    paused = false;
    start();
  });
  deck.addEventListener("focusin", () => {
    paused = true;
    stop();
  });
  deck.addEventListener("focusout", (event) => {
    if (deck.contains(event.relatedTarget)) return;
    paused = false;
    start();
  });
  document.addEventListener("visibilitychange", () => {
    select(current);
    start();
  });
  reducedMotion.addEventListener?.("change", () => {
    if (reducedMotion.matches) {
      userPaused = true;
      motionOverride = false;
      syncPauseControl();
    }
    select(current);
    start();
  });
  if ("IntersectionObserver" in window) {
    const deckObserver = new IntersectionObserver(
      ([entry]) => {
        inViewport = entry?.isIntersecting ?? false;
        select(current);
        start();
      },
      { threshold: 0.08 },
    );
    deckObserver.observe(deck);
  }

  syncPauseControl();
  select(0);
  start();
}

function setupTargetTabs() {
  const tabs = [...document.querySelectorAll("[data-target-tab]")];
  const panels = [...document.querySelectorAll("[data-target-panel]")];
  if (tabs.length === 0 || panels.length === 0) return;

  const select = (target, moveFocus = false) => {
    for (const tab of tabs) {
      const active = tab.dataset.targetTab === target;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
      if (active && moveFocus) tab.focus();
    }
    for (const panel of panels) {
      const active = panel.dataset.targetPanel === target;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
    }
  };

  for (const [tabIndex, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab.dataset.targetTab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (tabIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      select(tabs[next].dataset.targetTab, true);
    });
  }

  select(tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.dataset.targetTab ?? tabs[0].dataset.targetTab);
}

function setupCommandCopy() {
  const button = document.querySelector("[data-copy-command]");
  if (!button) return;
  const idleLabel = button.textContent;

  button.addEventListener("click", async () => {
    const value = button.dataset.copyValue;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = "Copied to clipboard";
    } catch {
      const field = document.createElement("textarea");
      field.value = value;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      document.execCommand("copy");
      field.remove();
      button.textContent = "Copied to clipboard";
    }
    window.setTimeout(() => {
      button.textContent = idleLabel;
    }, 1800);
  });
}

setupNavigation();
setupReveal();
setupDeviceDeck();
setupTargetTabs();
setupCommandCopy();
