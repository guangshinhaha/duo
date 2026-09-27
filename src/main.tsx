import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { isTrayWindow } from "./shell/native.js";
import { TrayApp } from "./tray/TrayPopover.js";
import { initTheme } from "./theme.js";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/tokens.css";

// #35: the remembered theme stamps before first paint, so a launch never
// opens dark and flips.
initTheme();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    {isTrayWindow() ? <TrayApp /> : <App />}
  </StrictMode>,
);
