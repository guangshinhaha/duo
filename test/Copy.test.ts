// Node built-ins resolve at runtime; the app tsconfig deliberately has no node types.
// @ts-expect-error no node types by design
import { readFileSync, readdirSync, statSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { corpusSentence, lastImportSentence } from "../src/profile/knowledgeWords.js";

/*
 * The plain-language pass (#149): the daemon's nouns are the system talking
 * to itself, and an owner should never need a design doc to read what their
 * duo says. This scans the words the live app writes — JSX text, the words in
 * attributes a person reads, and every prose string in the source — for the
 * daemon's jargon and for the words the redesign retired. Detail views and
 * strings the daemon owns are not scanned (they are the record, verbatim).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "api") {
          walk(path);
        }
      } else if (/\.tsx?$/.test(name)) {
        out.push(path);
      }
    }
  };
  walk(join(root, "src"));
  return out;
}

/** [pattern, why it is banned] */
const BANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bT[0-4]\b/, "a trust tier code — say what it covers (TIER_WORDS)"],
  [/\bcorpus\b/i, "the daemon's word for what your duo has read"],
  [/\bsuperseded\b/i, "a rule status, not a thing an owner says"],
  [/\bconsistency\b/i, "say how consistent, or leave it to the bar"],
  [/\bstale\b/i, "say 'not seen lately'"],
  [/\bproviders?\b/i, "say what it runs on"],
  [/\bderived\b/i, "say 'worked out from', 'built from'"],
  [/\bIgnor(?:e|ing|ed)\b/, "the verb is Dismiss (vocabulary.md)"],
  [/\bMirror\b/, "retired: it is the duo's Portrait and Rules"],
  [/\brecords\b/i, "say 'messages and notes' or 'history'"],
];

/** Attributes whose value a person reads. Everything else (className, data-*, href, key…) is not copy. */
const COPY_ATTRIBUTES = new Set(["placeholder", "aria-label", "title", "alt", "label"]);

/** Where a string is a developer's, not the owner's: errors, logs, imports. */
function isDeveloperString(node: ts.Node): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isLiteralTypeNode(parent) || ts.isTypeNode(parent)) {
      return true;
    }
    if (ts.isNewExpression(parent) && ts.isIdentifier(parent.expression) && /Error$/.test(parent.expression.text)) {
      return true;
    }
    if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && parent.expression.expression.getText() === "console") {
      return true;
    }
    if (ts.isJsxAttribute(parent)) {
      return !COPY_ATTRIBUTES.has(parent.name.getText());
    }
    if (ts.isPropertyAssignment(parent) && /^(testId|key|type|role|name|id|htmlFor|kind|state|className|href|method|queryKey|state)$/.test(parent.name.getText())) {
      return true;
    }
    if (ts.isElementAccessExpression(parent) || ts.isCaseClause(parent) || ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind)) {
      return true;
    }
  }
  return false;
}

const looksLikeClasses = (text: string): boolean => /\b(?:flex|gap-|px-|py-|p-\d|text-\[|bg-\[|border|rounded|min-h|shape-|type-(?:body|heading|provenance|identifier)|items-|justify-|w-\d|h-\d)/.test(text);

function prose(file: string): Array<{ text: string; line: number }> {
  const path = join(root, file);
  const ast = ts.createSourceFile(file, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: Array<{ text: string; line: number }> = [];
  const add = (node: ts.Node, text: string): void => {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed && !looksLikeClasses(trimmed) && /[A-Za-z]/.test(trimmed)) {
      found.push({ text: trimmed, line: ast.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) {
      add(node, node.text);
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !isDeveloperString(node)) {
      // Prose has words; a lone token is an identifier, a path or a status word — except in attributes a person reads.
      if (/\s/.test(node.text.trim()) || ts.isJsxAttribute(node.parent)) {
        add(node, node.text);
      }
    } else if ((ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && !isDeveloperString(node)) {
      if (/\s/.test(node.text.trim())) {
        add(node, node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

describe("the app speaks in an owner's words (#149)", () => {
  it("no daily surface carries the daemon's jargon or the words the redesign retired", () => {
    const offenders: string[] = [];
    for (const path of sources()) {
      const file = path.slice(root.length + 1);
      for (const { text, line } of prose(file)) {
        for (const [pattern, why] of BANNED) {
          if (pattern.test(text)) {
            offenders.push(`${file}:${line} "${text.slice(0, 80)}" — ${pattern} (${why})`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the placeholder and label of the answer box do not name the machinery", () => {
    for (const file of ["src/components/DraftTray.tsx", "src/components/DraftCard.tsx"]) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text).not.toMatch(/(?:placeholder|aria-label)="[^"]*candidate[^"]*"/);
    }
  });

  it("the shared sentences the daemon's counts are said in are plain", () => {
    const sentences = [
      lastImportSentence({ runAt: "2026-09-01T00:00:00.000Z", staged: 3, written: 2, alreadyPresent: 1, skippedDmConversations: 4, discardedOtherText: 0, discardedAboveCeiling: 0 } as never),
      lastImportSentence(null),
      corpusSentence({ tooThin: true, minimumQuestionsToCharacterize: 10, totalQuestions: 4, periodStart: null, periodEnd: null, topicBreakdown: [] }),
      corpusSentence({ tooThin: false, minimumQuestionsToCharacterize: 10, totalQuestions: 41, periodStart: null, periodEnd: null, topicBreakdown: [] }),
    ];
    for (const sentence of sentences) {
      for (const [pattern] of BANNED) {
        expect(sentence, sentence).not.toMatch(pattern);
      }
    }
  });

  it("owner-facing times are relative by default; the exact stamp is the detail view's", () => {
    const stamps: string[] = [];
    for (const path of sources()) {
      const file = path.slice(root.length + 1);
      const text = readFileSync(path, "utf8");
      // A raw locale timestamp in JSX or a template is a default view speaking in seconds.
      for (const match of text.matchAll(/toLocale(?:String|TimeString)\(/g)) {
        stamps.push(`${file}: ${text.slice(Math.max(0, match.index - 60), match.index + 20).replace(/\s+/g, " ")}`);
      }
    }
    // The exact stamps that remain are deliberate: the Activity detail's record line, the offline bar's "last seen at",
    // and the retired old screens' (not scanned), and #261's scheduled sends — a time something WILL go out is a
    // promise of when, which "in 9 hours" would blur. #270's away end time is the same kind of promise ("away until
    // Mon 12 Oct, 09:00" is what colleagues are told). #287's status end time is the identical promise — "In a
    // meeting until 3pm" blurs exactly the same way "in 2 hours" would once a minute has passed. Anything new here
    // must be argued for.
    expect([...new Set(stamps.map((entry) => entry.split(":")[0]))].sort()).toEqual([
      "src/components/OfflineBar.tsx",
      "src/components/SendControls.tsx",
      "src/components/StatusAndPresence.tsx",
      "src/profile/Activity.tsx",
      "src/profile/Away.tsx",
    ]);
  });
});
