import { openJournalDB, runHourlyCleanup } from "./db.js";
import { UI } from "./ui.js";

const APP_VERSION = "1.0.0";

let db;
let ui;

function setTopbarSub(text) {
  const el = document.getElementById("topbarSub");
  if (el) el.textContent = text;
}

function showBanner(kind, text, ms = 3500) {
  const host = document.getElementById("bannerHost");
  if (!host) return;

  const div = document.createElement("div");
  div.className = `banner ${kind === "error" ? "banner-error" : kind === "warn" ? "banner-warn" : ""}`;
  div.textContent = text;

  host.appendChild(div);
  window.setTimeout(() => {
    div.remove();
  }, ms);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  try {
    const reg = await navigator.serviceWorker.register("./service-worker.js", { scope: "./" });
    reg.addEventListener("updatefound", () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener("statechange", () => {
        if (sw.state === "installed" && navigator.serviceWorker.controller) {
          showBanner("warn", "Update available. Close and reopen the app to apply.");
        }
      });
    });
  } catch (e) {
    // SW failure should not block usage.
    showBanner("warn", "Service worker not available. Offline may be limited.");
  }
}

function setupOnlineIndicators() {
  const update = () => setTopbarSub(navigator.onLine ? "Online" : "Offline");
  window.addEventListener("online", update);
  window.addEventListener("offline", update);
  update();
}

function setupInstallPrompt() {
  const installBar = document.getElementById("installBar");
  const btnInstall = document.getElementById("btnInstall");
  const btnDismiss = document.getElementById("btnInstallDismiss");

  if (!installBar || !btnInstall || !btnDismiss) return;

  let deferredPrompt = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBar.hidden = false;
  });

  btnInstall.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try {
      await deferredPrompt.userChoice;
    } finally {
      deferredPrompt = null;
      installBar.hidden = true;
    }
  });

  btnDismiss.addEventListener("click", () => {
    installBar.hidden = true;
    deferredPrompt = null;
  });
}

async function bestEffortPortraitLock() {
  try {
    if (screen?.orientation?.lock) {
      await screen.orientation.lock("portrait");
    }
  } catch {
    // Not supported on all Android contexts, ignore.
  }
}

function setupTodayButton() {
  const btn = document.getElementById("btnToday");
  if (!btn) return;
  btn.addEventListener("click", () => {
    ui?.goToToday?.();
  });
}

async function init() {
  setupOnlineIndicators();
  setupInstallPrompt();
  setupTodayButton();
  await registerServiceWorker();
  await bestEffortPortraitLock();

  try {
    db = await openJournalDB();
  } catch (e) {
    showBanner("error", "IndexedDB failed to open. The app cannot save data on this device.");
    console.error(e);
    return;
  }

  ui = new UI({
    db,
    appVersion: APP_VERSION,
    onBanner: showBanner,
  });

  await ui.mount(document.getElementById("app"));

  // Cleanup on load
  try {
    await runHourlyCleanup(db);
  } catch (e) {
    console.warn("Cleanup failed", e);
  }

  // Cleanup hourly while open
  window.setInterval(async () => {
    try {
      await runHourlyCleanup(db);
    } catch (e) {
      console.warn("Cleanup failed", e);
    }
  }, 60 * 60 * 1000);
}

init();
