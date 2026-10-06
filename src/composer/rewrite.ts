import { REWRITE_INSTRUCTIONS, type RewriteInstruction } from "../api/types.js";

export { REWRITE_INSTRUCTIONS, type RewriteInstruction };

/** #263's own menu — the composer renders these in this order, Rewrite first (the general case) down to Proofread (the smallest change). */
export const REWRITE_INSTRUCTION_LABEL: Record<RewriteInstruction, string> = {
  rewrite: "Rewrite",
  shorter: "Shorter",
  warmer: "Warmer",
  proofread: "Proofread",
};
