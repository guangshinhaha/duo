import { useState } from "react";

/**
 * A value shown once for the owner to carry elsewhere (a device token, an
 * ask link) — selectable text plus a copy button. The clipboard can be
 * unavailable (insecure context, denied permission); the text stays
 * selectable either way, and the button says when copying failed.
 */
export function CopyableSecret({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="flex flex-col gap-1">
      <span className="type-provenance text-[var(--muted)]">{label}</span>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-[var(--r-sm)] bg-[var(--surface-2)] p-2 type-identifier" data-testid={testId}>
          {value}
        </code>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]"
          onClick={() => {
            navigator.clipboard
              ?.writeText(value)
              .then(() => setCopied("copied"))
              .catch(() => setCopied("failed"));
            if (!navigator.clipboard) {
              setCopied("failed");
            }
          }}
          type="button"
        >
          {copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed — select it" : `Copy ${label.toLowerCase()}`}
        </button>
      </div>
    </div>
  );
}
