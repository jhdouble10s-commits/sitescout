import {
  readAccess
} from "./chunk-ITRHU4VH.js";
import {
  client
} from "./chunk-VXYETN7S.js";

// startup-screen.js
function showStartupPhase(phase) {
  const screen = document.querySelector("#accessMessage");
  if (!screen || screen.dataset.phase === "error" && phase !== "error") return;
  screen.dataset.phase = phase;
  const failed = phase === "error";
  screen.querySelector(".startup-status").setAttribute("role", failed ? "alert" : "status");
  screen.querySelector(".startup-title").textContent = failed ? "\uD3B8\uC9D1\uAE30\uB97C \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4." : "\uC791\uC5C5\uC2E4\uC744 \uC5F4\uACE0 \uC788\uC5B4\uC694";
  screen.querySelector(".startup-description").textContent = failed ? "\uC5F0\uACB0 \uC0C1\uD0DC\uB97C \uD655\uC778\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694." : "\uC791\uC5C5 \uACF5\uAC04\uC744 \uC900\uBE44\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uC7A0\uC2DC\uB9CC \uAE30\uB2E4\uB824 \uC8FC\uC138\uC694.";
  const retry = screen.querySelector(".startup-retry");
  retry.hidden = !failed;
  if (failed) retry.href = location.href;
}

// app-access.js
var revision = 0;
var activeUserId = null;
var accessVerified = false;
var checkInFlight = null;
var isAccessVerified = () => accessVerified;
var appNode = () => document.querySelector(".app");
var lock = () => {
  const app = appNode();
  if (app) {
    app.inert = true;
    app.style.visibility = "hidden";
  }
  const screen = document.querySelector("#accessMessage");
  if (screen) screen.hidden = false;
};
function markAppUiReady() {
  document.documentElement.dataset.appUiReady = "true";
  const app = appNode();
  if (!app || !activeUserId || !accessVerified) return;
  app.inert = false;
  app.style.removeProperty("visibility");
  const screen = document.querySelector("#accessMessage");
  if (screen) screen.hidden = true;
}
async function performAccessCheck() {
  const targetRevision = ++revision;
  accessVerified = false;
  if (!activeUserId) lock();
  try {
    const access = await readAccess(client);
    if (targetRevision !== revision) return null;
    if (activeUserId && activeUserId !== access.user.id) {
      lock();
      window.dispatchEvent(new Event("sitescout-identity-invalidated"));
      location.reload();
      return null;
    }
    activeUserId = access.user.id;
    accessVerified = true;
    showStartupPhase("editor");
    if (document.documentElement.dataset.appUiReady === "true") markAppUiReady();
    return access;
  } catch (error) {
    if (targetRevision !== revision) return null;
    if (error.code === "stale") {
      queueMicrotask(() => {
        checkInFlight = null;
        void checkAccess();
      });
      return null;
    }
    lock();
    if (error.code === "unavailable") {
      showStartupPhase("error");
      if (activeUserId && targetRevision === revision)
        document.querySelector("#accessMessage .startup-description").textContent = "\uBBF8\uC800\uC7A5 \uC6D0\uACE0\uB294 \uD604\uC7AC \uD0ED\uC5D0\uB9CC \uB0A8\uC544 \uC788\uC2B5\uB2C8\uB2E4. \uD0ED\uC744 \uB2EB\uC9C0 \uB9D0\uACE0 \uC5F0\uACB0\uC744 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.";
      if (targetRevision !== revision) return null;
      const retry = document.querySelector("#accessMessage .startup-retry");
      if (retry && activeUserId) {
        retry.onclick = (event) => {
          event.preventDefault();
          document.querySelector("#accessMessage").dataset.phase = "access";
          showStartupPhase("access");
          void checkAccess();
        };
      }
      return null;
    }
    window.dispatchEvent(new Event("sitescout-identity-invalidated"));
    location.replace(`login/?reason=${encodeURIComponent(error.code || "unavailable")}`);
    return null;
  }
}
function checkAccess() {
  if (!checkInFlight) {
    const task = performAccessCheck();
    checkInFlight = task;
    void task.finally(() => {
      if (checkInFlight === task) checkInFlight = null;
    });
  }
  return checkInFlight;
}
var appAccess = checkAccess();
var verifyAccess = checkAccess;
client.auth.onAuthStateChange((event, session) => {
  if (event === "INITIAL_SESSION") return;
  const identityChanged = event === "SIGNED_OUT" || activeUserId && session?.user?.id !== activeUserId;
  if (identityChanged) {
    revision++;
    accessVerified = false;
    lock();
    window.dispatchEvent(new Event("sitescout-identity-invalidated"));
    checkInFlight = null;
  }
  setTimeout(() => {
    void appAccess.then(checkAccess);
  }, 0);
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) void appAccess.then(checkAccess);
});
window.addEventListener("focus", () => {
  void appAccess.then(checkAccess);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void appAccess.then(checkAccess);
});

export {
  showStartupPhase,
  isAccessVerified,
  markAppUiReady,
  appAccess,
  verifyAccess
};
