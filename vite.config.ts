import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
//
// No dev-server proxy: apiRequest (src/api/client.ts) always fetches an
// absolute `${baseUrl}${path}` URL — baseUrl comes from Setup.tsx's
// pairing flow and is always a full origin, by design (client-tech-
// design.md §1.1: the daemon binds a tailnet address, and the whole point
// is a phone reaching a Mac over that tailnet, not a relative-path dev
// convenience). A "/api" proxy here would be dead configuration with
// nothing ever routed through it — pair against a real `duo serve`
// instance during `npm run dev` the same way the built app does.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // matrix-js-sdk's HTTP layer calls the bare Node global `global.fetch(...)`
  // (lib/http-api/fetch.js). Vite's browser build never defines `global` —
  // it's Node-only — so every real-browser call throws `ReferenceError:
  // global is not defined` synchronously, before any network request, which
  // `App.tsx`'s workspace-connect try/catch then swallows silently (report
  // "failed", no console output). Vitest never caught this because tests run
  // inside a real Node process, where `global` always exists regardless of
  // the happy-dom/jsdom environment. `globalThis` is the single aliased
  // global object browsers and Node both already expose — point `global` at
  // it, as `window.global`, for any bundled code built against Node's API.
  define: { global: "globalThis" },
  // Two entries: the paired owner app (`index.html`) and the no-install
  // asker page (`ask.html`, duo #1/#2). Both must be named explicitly —
  // an `input` object replaces Vite's default `index.html`-only entry —
  // so the app keeps building exactly as before alongside the new page.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        ask: fileURLToPath(new URL("./ask.html", import.meta.url)),
      },
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
    // vitest's defaults don't know about `.claude/worktrees/**` — agent
    // worktrees checked out inside this repo carry their own (often
    // mid-edit) test files, which would otherwise run as part of every
    // `npm test` here and fail for reasons this checkout cannot fix.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
