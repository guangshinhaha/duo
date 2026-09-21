import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { initTheme } from "./theme.js";
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
    <App />
  </StrictMode>,
);
