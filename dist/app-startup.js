import {
  showStartupPhase
} from "./chunks/chunk-2HDZU5YC.js";
import "./chunks/chunk-XCBH6NLF.js";

// app-startup.js
try {
  const { initializeApp } = await import("./chunks/ui-GNOIKGK3.js");
  if (document.readyState === "loading") {
    await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
  }
  await initializeApp();
} catch (error) {
  console.error("\uD3B8\uC9D1\uAE30 \uCD08\uAE30\uD654 \uC2E4\uD328:", error);
  const app = document.querySelector(".app");
  if (app) {
    app.inert = true;
    app.style.visibility = "hidden";
  }
  showStartupPhase("error");
}
