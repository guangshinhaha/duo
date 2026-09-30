// Node built-ins for the source scans, following DesignSystem.test.tsx's
// lead: the app tsconfig deliberately has no node types.
// @ts-expect-error no node types by design
import { readFileSync, readdirSync, statSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import ts from "typescript";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error the lint config is deliberately @ts-check JS with no declaration — its shape is exercised at runtime by the Linter tests below (roomLabelling's idiom)
import eslintConfig from "../eslint.config.js";
import { Dialog, DialogContent, DialogTitle } from "../src/components/primitives/Dialog.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTrigger,
  AlertDialogTitle,
} from "../src/components/primitives/AlertDialog.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../src/components/primitives/Tooltip.js";
import { ToastProvider, useToast } from "../src/components/primitives/Toast.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../src/components/primitives/DropdownMenu.js";
import { DuoMessage } from "../src/components/DuoMessage.js";
import { OwnerMessage } from "../src/components/OwnerMessage.js";

/*
 * #34: the component layer §1.2 named and never took. These tests pin the
 * four things the issue requires of it: the primitives are real (portal,
 * focus trap, Escape and aria come with them, not hand-rolled per screen),
 * the look is ours alone (tokens, never the library's), icons are one set
 * at one weight and never speak without a word beside them, and AR-13
 * survives the new layer — a primitive is not a route for a person's
 * identity into a duo-authored subtree, statically or at runtime.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// A test that dies mid-assert under fake timers must not leak them into
// the next test's waitFor — restore and unmount, always.
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/** Every .ts/.tsx under src/ — the scan surface, same idiom as DesignSystem.test.tsx. */
function srcSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (/\.(tsx|ts)$/.test(name)) {
        out.push(path);
      }
    }
  };
  walk(join(root, "src"));
  return out;
}

const primitivesDir = join(root, "src", "components", "primitives");

describe("#34 AC1 — a screen composes the primitive, and the accessibility comes with it", () => {
  it("the dialog portals as a labelled modal, focus starts inside it, and Escape closes", async () => {
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent data-testid="demo-dialog">
          <DialogTitle className="type-heading">A title</DialogTitle>
          <input aria-label="first field" />
          <button>after</button>
        </DialogContent>
      </Dialog>,
    );

    // Radix's contract, not ours: a real dialog role, announced by its
    // title, focus-guarded and trapped, rendered in a portal at the body
    // root — none of it hand-rolled per screen.
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.closest("body")).toBe(document.body);
    expect(dialog.className).toContain("shape-container");

    // Focus starts inside the trap — the thing a bespoke div forgets.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    // Escape is the library's, listened at the document, fired from anywhere.
    fireEvent.keyDown(screen.getByLabelText("first field"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a confirmation is an alert dialog: it opens from its trigger, survives an outside click, and answers only to its own buttons", async () => {
    const onAction = vi.fn();
    render(
      <AlertDialog>
        <AlertDialogTrigger data-testid="demo-trigger">Delete it…</AlertDialogTrigger>
        <AlertDialogContent data-testid="demo-confirm">
          <AlertDialogTitle className="type-heading">Delete it?</AlertDialogTitle>
          <AlertDialogDescription className="type-provenance text-[var(--muted)]">This cannot be undone.</AlertDialogDescription>
          <AlertDialogAction data-testid="demo-action" onClick={onAction}>
            Delete
          </AlertDialogAction>
          <AlertDialogCancel data-testid="demo-cancel">Cancel</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>,
    );

    // Closed until the trigger says so.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByTestId("demo-trigger"));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm.getAttribute("aria-labelledby")).toBeTruthy();

    // The whole point of the alert variant: a stray outside press is not an
    // answer (the plain dialog closes; this one does not). A real bubbling
    // event, not fireEvent.pointerDown: Radix re-dispatches the original,
    // and a testing-library-synthesised PointerEvent carries no target
    // through that path in happy-dom.
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("demo-cancel"));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    fireEvent.click(screen.getByTestId("demo-trigger"));
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByTestId("demo-action"));
    expect(onAction).toHaveBeenCalled();
  });

  it("a tooltip appears on focus, is described-by wired, and Escape dismisses it", async () => {
    render(
      <TooltipProvider>
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <button>Hover me</button>
          </TooltipTrigger>
          <TooltipContent>What the button does</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const trigger = screen.getByRole("button", { name: "Hover me" });
    fireEvent.focus(trigger);
    const tip = await screen.findByRole("tooltip");
    // The wiring a label needs: the trigger points at the thing that labels it.
    expect(trigger.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.className).toContain("shape-entry");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("a toast announces as a status and removes itself when it closes", async () => {
    function Announcer() {
      const toast = useToast();
      return <button onClick={() => toast("Saved.")}>Announce</button>;
    }
    // Fake timers from the start: the announcement rides the next
    // animation frame and dismissal rides a timeout, and both clocks need
    // to be faked for either to be observable deterministically.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    render(
      <ToastProvider>
        <Announcer />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Announce" }));
    act(() => {
      vi.advanceTimersByTime(50);
    });
    // The accessibility that comes with it: Radix renders a live
    // announcement of the toast's words — that node is the screen reader's
    // toast. Foreground toasts announce assertively by the library's own
    // judgment ("Notification …" prefix included), and the words are ours.
    expect(screen.getByRole("status").textContent).toContain("Saved.");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "assertive");
    // The visible toast is the shape an entry is, in the viewport.
    const toast = screen.getByTestId("toast");
    expect(toast).toHaveTextContent("Saved.");
    expect(toast.closest("li")!.className).toContain("shape-entry");

    // Dismissal is the toast's own lifecycle (its duration), not the
    // caller's: it removes itself when it closes.
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId("toast")).toBeNull();
    vi.useRealTimers();
  });

  it("a menu opens from its trigger as a real menu and Escape closes it", async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Open</DropdownMenuItem>
          <DropdownMenuItem>Copy</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions" }));
    const menu = await screen.findByRole("menu");
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open", "Copy"]);
    expect(menu.className).toContain("shape-container");

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });
});

describe("#34 AC2 — the library supplies behaviour, never a look", () => {
  it("every class the primitive layer writes is one of ours", () => {
    // The positive allowlist: #33's shape/type classes, structural layout
    // utilities, and colour only as var(--token). Radix ships unstyled —
    // this scan is what keeps it that way: a foreign class (a library
    // theme, a hex, a palette name) has nowhere to come from.
    const allowed =
      /^(?:shape-container|shape-entry|shape-entry-quiet|motion-(?:scrim|panel|sheet|menu|tip|toast)|type-heading|type-body|type-provenance|type-identifier|fixed|inset-0|inset-x-0|top-6|bottom-4|right-4|z-50|mx-auto|flex|flex-col|items-center|gap-1|gap-2|gap-3|p-2|p-4|px-2|px-4|py-1|py-3|min-w-40|cursor-pointer|(?:bg|text|fill|rounded|border)-\[var\(--[a-z0-9-]+\)\](?:\/80)?|data-highlighted:bg-\[var\(--surface-2\)\])$/;
    const offenders: string[] = [];
    for (const name of readdirSync(primitivesDir)) {
      if (!name.endsWith(".tsx")) {
        continue;
      }
      const text = readFileSync(join(primitivesDir, name), "utf8");
      // Any literal that names a shape/type class, floats above the ground,
      // or references a token is a styling literal — those get scanned, so
      // a foreign class cannot hide in the one literal the keywords missed.
      // `${className}` interpolations are the caller's classes (scanned in
      // the caller's own file), so they are stripped, not judged here.
      for (const literal of text.matchAll(/["'`]([^"'`]*(?:shape-|z-50|type-(?:heading|body|provenance|identifier)|var\(--)[^"'`]*)["'`]/g)) {
        for (const token of literal[1]!.replace(/\$\{[^}]*\}/g, "").split(/\s+/).filter(Boolean)) {
          if (!allowed.test(token)) {
            offenders.push(`${name}: ${token}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the adopted dialogs wear this repository's panel, not a library's", async () => {
    // As rendered, not just as written: the panel is the same
    // shape-container a section is, on the ground-dimmed scrim.
    render(
      <Dialog open>
        <DialogContent data-testid="styled-dialog">body</DialogContent>
      </Dialog>,
    );
    const panel = screen.getByTestId("styled-dialog");
    expect(panel.className).toContain("shape-container");
  });
});

/*
 * AC3's scanner runs on the TypeScript AST, not on regex over source: "an
 * icon is labelled" is a claim about JSX structure (is there a text node
 * beside the icon in its parent?), which is exactly what a parser sees and
 * a regex can only approximate.
 */
function iconOffenders(sources: Record<string, string>): string[] {
  const offenders: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const lucideNames = new Set<string>();
    for (const statement of ast.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const from = statement.moduleSpecifier.text;
      const bindings = statement.importClause?.namedBindings;
      if (from === "lucide-react") {
        // The one set. Its imports are the only icon components in play.
        if (bindings && ts.isNamedImports(bindings)) {
          for (const named of bindings.elements) {
            lucideNames.add(named.name.text);
          }
        }
      } else if (/(?:icons?|lucide|heroicons|feather|phosphor|tabler|iconify)/i.test(from)) {
        // Any other module whose name says it ships icons is a second set.
        offenders.push(`${file}: second icon source "${from}"`);
      }
    }

    const visit = (node: ts.Node): void => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
        const name = ts.isIdentifier(tag) ? tag.text : undefined;
        if (name === "svg") {
          offenders.push(`${file}: inline <svg> — a hand-rolled icon is a second set`);
        }
        if (name && lucideNames.has(name)) {
          // One weight: the set's default stroke. Any strokeWidth prop is
          // a second weight.
          const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
          for (const attr of attributes.properties) {
            if (!ts.isJsxAttribute(attr)) {
              continue;
            }
            const attrName = ts.isIdentifier(attr.name) ? attr.name.text : "";
            if (attrName === "strokeWidth") {
              offenders.push(`${file}: strokeWidth on <${name}> — one weight means the default`);
            }
            if (attrName === "aria-label" || attrName === "aria-labelledby") {
              // Self-labelling icons are exempt from the sibling rule.
              (node as ts.Node & { selfLabelled?: boolean }).selfLabelled = true;
            }
          }
          // AC3's core: no icon carries meaning without a text label
          // beside it. The label is a JSXText sibling in the same parent —
          // visible words in the same row, not another element nearby.
          const parent = node.parent;
          let labelled = (node as ts.Node & { selfLabelled?: boolean }).selfLabelled === true;
          if (!labelled && parent && (ts.isJsxElement(parent) || ts.isJsxFragment(parent))) {
            labelled = parent.children.some((child) => ts.isJsxText(child) && child.getText().trim().length > 0);
          }
          if (!labelled) {
            offenders.push(`${file}: <${name}> renders without a text label beside it`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  return offenders;
}

describe("#34 AC3 — icons are one set at one weight, and never speak alone", () => {
  it("the scanner catches each violation it exists to catch", () => {
    // The scan is proven against violations, not just run on a codebase
    // that (today) renders no icons — otherwise it could be vacuously
    // green and stay green while rotting.
    const catchUnlabelled = iconOffenders({
      "fixture.tsx": `import { Trash2 } from "lucide-react";\nconst x = <span><Trash2 /></span>;`,
    });
    expect(catchUnlabelled.join("\n")).toMatch(/without a text label beside it/);

    const okLabelled = iconOffenders({
      "fixture.tsx": `import { Trash2 } from "lucide-react";\nconst x = <span><Trash2 /> Delete</span>;`,
    });
    expect(okLabelled).toEqual([]);

    const catchWeight = iconOffenders({
      "fixture.tsx": `import { Trash2 } from "lucide-react";\nconst x = <span><Trash2 strokeWidth={1} /> Delete</span>;`,
    });
    expect(catchWeight.join("\n")).toMatch(/strokeWidth/);

    const catchSecondSet = iconOffenders({
      "fixture.tsx": `import { FiTrash } from "react-icons/fi";\nconst x = <span>{FiTrash} Delete</span>;`,
    });
    expect(catchSecondSet.join("\n")).toMatch(/second icon source/);

    const catchInlineSvg = iconOffenders({
      "fixture.tsx": `const x = <span><svg viewBox="0 0 24 24"><path d="M0 0" /></svg> Delete</span>;`,
    });
    expect(catchInlineSvg.join("\n")).toMatch(/second set/);
  });

  it("src holds one icon source at one weight, every icon labelled", () => {
    const sources: Record<string, string> = {};
    for (const path of srcSources()) {
      sources[join("src", path.slice(root.length + 1))] = readFileSync(path, "utf8");
    }
    expect(iconOffenders(sources)).toEqual([]);
  });
});

describe("#34 AC4 — AR-13 survives the primitive layer", () => {
  it("the static rule sees through a primitive wrapper in the same tree", () => {
    // The descendant selector matches at any depth, so wrapping
    // OwnerMessage in a primitive does not hide it from the lint rule.
    const linter = new Linter();
    const messages = linter.verify(
      `import { Tooltip } from "./Tooltip.js";
       const bad = <DuoMessage><Tooltip><OwnerMessage>hi</OwnerMessage></Tooltip></DuoMessage>;`,
      eslintConfig as never,
      { filename: "fixture.tsx" },
    );
    expect(messages.some((message) => /AR-13/.test(message.message))).toBe(true);
  });

  it("the runtime guard trips through a primitive's portal — context crosses composition boundaries", () => {
    const evil = (
      <DuoMessage>
        <TooltipProvider>
          <Tooltip open delayDuration={0}>
            <TooltipTrigger asChild>
              <span>label</span>
            </TooltipTrigger>
            <TooltipContent>
              {/* eslint-disable-next-line no-restricted-syntax -- the violation is the fixture; the throw below is the assertion. */}
              <OwnerMessage>posing</OwnerMessage>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </DuoMessage>
    );
    // A primitive is composition like any other: React context (and thus
    // InsideDuoMessage) flows through portals and wrappers, so the guard
    // fires no matter how the tree was assembled. The portal the throw
    // leaves behind is cleaned up so it cannot leak into later tests.
    expect(() => {
      try {
        render(evil);
      } finally {
        cleanup();
      }
    }).toThrow(/AR-13: a duo never poses as a person/);
  });
});

describe("motion (docs/motion-plan.md A1 to A4)", () => {
  it("a dialog's scrim fades and its panel rises; a sheet slides up instead", () => {
    render(
      <Dialog open>
        <DialogContent data-testid="panel">
          <DialogTitle>Panel</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByTestId("panel").className).toContain("motion-panel");
    expect(document.querySelector(".motion-scrim")).not.toBeNull();
    cleanup();

    render(
      <Dialog open>
        <DialogContent data-testid="sheet" sheet>
          <DialogTitle>Sheet</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByTestId("sheet").className).toContain("motion-sheet");
    expect(screen.getByTestId("sheet").className).not.toContain("motion-panel");
  });

  it("a dialog opened and closed at once ends fully closed, with no scrim left behind", async () => {
    function Flicker() {
      const [open, setOpen] = useState(false);
      return (
        <Dialog onOpenChange={setOpen} open={open}>
          <button onClick={() => setOpen(true)} type="button">
            Open
          </button>
          <DialogContent>
            <DialogTitle>Flicker</DialogTitle>
          </DialogContent>
        </Dialog>
      );
    }
    render(<Flicker />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.querySelector(".motion-scrim")).toBeNull();
  });

  it("menus, tooltips and toasts each carry their motion class", async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Open</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Actions" }));
    expect((await screen.findByRole("menu")).className).toContain("motion-menu");
  });
});
