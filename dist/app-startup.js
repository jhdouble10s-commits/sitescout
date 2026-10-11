import {
  fetchProjectIndex
} from "./chunks/chunk-MLQKDZ6E.js";
import {
  appAccess,
  isAccessVerified,
  showStartupPhase,
  verifyAccess
} from "./chunks/chunk-BVXJMWKM.js";
import "./chunks/chunk-ITRHU4VH.js";
import {
  client
} from "./chunks/chunk-VXYETN7S.js";
import "./chunks/chunk-XCBH6NLF.js";

// project-launcher.js
var launcher = document.querySelector("#projectLauncher");
var list = launcher.querySelector(".project-launcher-list");
var message = launcher.querySelector(".project-launcher-message");
var newButton = launcher.querySelector("[data-project-new]");
var retryButton = launcher.querySelector("[data-project-retry]");
var invalidated = false;
window.addEventListener("sitescout-identity-invalidated", () => {
  invalidated = true;
  list.replaceChildren();
  launcher.hidden = true;
});
function hideProjectLauncher() {
  launcher.hidden = true;
}
async function chooseInitialProject() {
  const access = await appAccess;
  if (!access || invalidated) return null;
  const ownerId = access.user.id;
  return new Promise((resolve) => {
    let loadingIndex = false;
    let choosing = false;
    let rowsVisible = false;
    let indexPromise = null;
    const choose = async (action, projectId) => {
      if (choosing || !rowsVisible || !indexPromise || invalidated) return;
      choosing = true;
      message.textContent = action === "open" ? "\uC120\uD0DD\uD55C \uC6D0\uACE0\uB97C \uC5EC\uB294 \uC911\uC785\uB2C8\uB2E4." : "\uC0C8 \uC791\uC5C5 \uACF5\uAC04\uC744 \uC5EC\uB294 \uC911\uC785\uB2C8\uB2E4.";
      launcher.querySelectorAll("button").forEach((button) => {
        button.disabled = true;
      });
      try {
        const index = await indexPromise;
        const verified = isAccessVerified() ? access : await verifyAccess();
        if (!verified || verified.user.id !== ownerId || invalidated) {
          choosing = false;
          if (!invalidated) launcher.querySelectorAll("button").forEach((button) => {
            button.disabled = false;
          });
          return;
        }
        resolve({ action, projectId, index });
      } catch {
        choosing = false;
      }
    };
    newButton.onclick = () => {
      void choose("new");
    };
    const load = async () => {
      if (loadingIndex || choosing || invalidated) return;
      loadingIndex = true;
      rowsVisible = false;
      newButton.disabled = true;
      retryButton.hidden = true;
      message.textContent = "\uD504\uB85C\uC81D\uD2B8 \uBAA9\uB85D\uC744 \uBD88\uB7EC\uC624\uB294 \uC911\uC785\uB2C8\uB2E4.";
      try {
        indexPromise = fetchProjectIndex(client, ownerId, async (rows) => {
          const verified2 = isAccessVerified() ? access : await verifyAccess();
          if (!verified2 || verified2.user.id !== ownerId || invalidated || !rows.length) return;
          list.replaceChildren();
          rows.forEach((row) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "project-launcher-item";
            button.textContent = row.title;
            button.addEventListener("click", () => {
              void choose("open", row.project_id);
            });
            list.append(button);
          });
          rowsVisible = true;
          newButton.disabled = false;
          message.textContent = `${rows.length}\uAC1C \uD504\uB85C\uC81D\uD2B8 \uC911 \uD558\uB098\uB97C \uC120\uD0DD\uD558\uC138\uC694.`;
          launcher.hidden = false;
          document.querySelector("#accessMessage").hidden = true;
        });
        const result = await indexPromise;
        const verified = isAccessVerified() ? access : await verifyAccess();
        if (!verified || verified.user.id !== ownerId || invalidated) return;
        if (!result.rows.length) resolve({ action: "new", index: result });
      } catch {
        if (invalidated) return;
        rowsVisible = false;
        list.replaceChildren();
        newButton.disabled = true;
        message.textContent = "\uD504\uB85C\uC81D\uD2B8 \uBAA9\uB85D\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uC5F0\uACB0\uC744 \uD655\uC778\uD558\uACE0 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694.";
        retryButton.hidden = false;
        retryButton.disabled = false;
        launcher.hidden = false;
        document.querySelector("#accessMessage").hidden = true;
      } finally {
        loadingIndex = false;
      }
    };
    retryButton.onclick = () => {
      void load();
    };
    void load();
  });
}

// app-startup.js
try {
  if (document.readyState === "loading") {
    await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  }
  const selection = await chooseInitialProject();
  if (selection) {
    const { initializeApp } = await import("./chunks/ui-WF6AIUB4.js");
    await initializeApp({
      initialProjectIndex: selection.index,
      initialProjectId: selection.action === "open" ? selection.projectId : null
    });
    hideProjectLauncher();
  }
} catch (error) {
  console.error("\uD3B8\uC9D1\uAE30 \uCD08\uAE30\uD654 \uC2E4\uD328:", error);
  hideProjectLauncher();
  const app = document.querySelector(".app");
  if (app) {
    app.inert = true;
    app.style.visibility = "hidden";
  }
  showStartupPhase("error");
}
