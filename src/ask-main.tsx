import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Ask } from "./routes/Ask.js";
import "./styles/tokens.css";

// The asker entry's twin of `main.tsx`, and deliberately nothing more:
// no App shell (no nav — the asker has no routes to navigate), no
// localStorage config (the connection details live in the link's hash,
// per `parseAskLink`).
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <Ask />
  </StrictMode>,
);
