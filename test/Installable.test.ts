// @ts-expect-error no node types by design
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * #152: the web client installs to a phone's home screen as it is — the path
 * to a phone that needs no signing, no store and no device build. This pins
 * the pieces that make a browser offer it: a manifest, icons of the sizes it
 * declares (a manifest pointing at a missing or wrong-sized icon fails
 * silently), and the page's own install tags.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** The bytes of a file, as much of Node's `Buffer` as these checks use (the app tsconfig has no node types). */
interface Bytes {
  subarray(start: number, end: number): { toString(encoding: string): string };
  readUInt32BE(offset: number): number;
  toString(encoding: string): string;
}
const read = (path: string): Bytes => readFileSync(join(root, path)) as Bytes;

/** A PNG's width and height, from its header — the file's own claim, not the manifest's. */
function pngSize(path: string): [number, number] {
  const bytes = read(path);
  expect(bytes.subarray(1, 4).toString("ascii"), `${path} is a PNG`).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
  share_target?: {
    action: string;
    method: string;
    enctype: string;
    params: { title?: string; text?: string; url?: string; files?: Array<{ name: string; accept: string[] }> };
  };
}

describe("the web client is installable (#152)", () => {
  const manifest = JSON.parse(read("public/manifest.json").toString("utf8")) as Manifest;
  const html = read("index.html").toString("utf8");

  it("has a manifest that opens standalone at the app's own address", () => {
    expect(manifest.name).toBe("Duo");
    expect(manifest.short_name).toBe("Duo");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    // The ground the app starts on, so the launch never flashes white.
    expect(manifest.background_color).toBe("#0b0c0e");
    expect(manifest.theme_color).toBe("#0b0c0e");
  });

  it("declares icons that exist and are the size they say — one full-bleed to be masked, and two to show as they are", () => {
    expect(manifest.icons.map((icon) => [icon.sizes, icon.purpose])).toEqual([
      ["192x192", "any"],
      ["512x512", "any"],
      ["512x512", "maskable"],
    ]);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngSize(`public${icon.src}`), icon.src).toEqual([w, h]);
    }
  });

  it("links the manifest and the iOS home-screen icon, and asks for a standalone app on both platforms", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.json"');
    expect(html).toContain('<link rel="apple-touch-icon" href="/brand/apple-touch-icon.png"');
    expect(pngSize("public/brand/apple-touch-icon.png")).toEqual([180, 180]);
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="mobile-web-app-capable" content="yes"');
    // Edge to edge, so the shell's safe-area padding has something to keep clear.
    expect(html).toContain("viewport-fit=cover");
  });

  it("colours the browser chrome for both themes", () => {
    expect(html).toContain('content="#0b0c0e" media="(prefers-color-scheme: dark)"');
    expect(html).toContain('content="#f7f7f8" media="(prefers-color-scheme: light)"');
  });

  it("#324: duo is a Web Share Target — a POST a real multipart body (title, text, url, files) can carry, landing on the picker's own address", () => {
    expect(manifest.share_target?.action).toBe("/share-target");
    expect(manifest.share_target?.method).toBe("POST");
    expect(manifest.share_target?.enctype).toBe("multipart/form-data");
    expect(manifest.share_target?.params.title).toBe("title");
    expect(manifest.share_target?.params.text).toBe("text");
    expect(manifest.share_target?.params.url).toBe("url");
    expect(manifest.share_target?.params.files?.[0]?.name).toBe("files");
    // `public/sw.js` is the one thing that can read a POST body at all on a
    // static host — the action must be exactly what it listens for.
    const sw = read("public/sw.js").toString("utf8");
    expect(sw).toContain('"/share-target"');
  });

  it("keeps the notch and the home indicator clear in the shell", () => {
    const shell = read("src/shell/ChatShell.tsx").toString("utf8");
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(shell).toContain(`env(safe-area-inset-${side})`);
    }
  });
});
