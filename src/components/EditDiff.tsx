/**
 * #23: the edit rendered as the change itself. The owner's most valuable
 * moment in the product is deciding what to correct — a bare textarea
 * makes it look like the least interesting one. While editing, the card
 * shows the duo's original with the owner's removals struck through and
 * additions marked, computed live as they type.
 *
 * Word-granularity LCS over prose tokens: the readable unit of a draft is
 * a word, not a character (character diffs turn "Five days" → "Ten days"
 * into "FivTe n days" noise) and not a line (drafts are paragraphs, so a
 * line diff would just mark the whole paragraph both ways). The diff is
 * presentation only — the daemon's `corrections/classify.ts` derives the
 * training signal from the texts it stores, never from this rendering.
 */

export type DiffOp = "same" | "removed" | "added";

export interface DiffSegment {
  op: DiffOp;
  text: string;
}

/** Splits keeping the whitespace between words as its own tokens, so unchanged prose keeps its exact spacing when rendered. */
function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token.length > 0);
}

/** Longest-common-subsequence diff of two token lists, as merged run segments. */
export function diffWords(original: string, edited: string): DiffSegment[] {
  const a = tokenize(original);
  const b = tokenize(edited);
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..]; drafts are short prose,
  // so the quadratic table is nothing next to a keystroke.
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (op: DiffOp, text: string): void => {
    const last = segments[segments.length - 1];
    if (last && last.op === op) {
      last.text += text;
    } else {
      segments.push({ op, text });
    }
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push("removed", a[i]);
      i++;
    } else {
      push("added", b[j]);
      j++;
    }
  }
  while (i < n) {
    push("removed", a[i]);
    i++;
  }
  while (j < m) {
    push("added", b[j]);
    j++;
  }
  return segments;
}

/** The duo's original inline with the owner's changes marked — `<del>` struck, `<ins>` marked, both reading in place. */
export function EditDiff({ original, edited }: { original: string; edited: string }) {
  return (
    <div className="whitespace-pre-wrap" data-testid="edit-diff">
      {diffWords(original, edited).map((segment, index) =>
        segment.op === "same" ? (
          <span key={index}>{segment.text}</span>
        ) : segment.op === "removed" ? (
          // `del`'s native strike-through is the at-a-glance cue; the color
          // names the verdict. Added text keeps its baseline (no underline)
          // — it is text to read, not a hyperlink.
          <del key={index} data-testid="edit-diff-removed" className="text-[var(--refused)]">
            {segment.text}
          </del>
        ) : (
          <ins key={index} data-testid="edit-diff-added" className="text-[var(--confident)] no-underline">
            {segment.text}
          </ins>
        ),
      )}
    </div>
  );
}
