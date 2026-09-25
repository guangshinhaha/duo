import { describe, expect, it } from "vitest";
import { duoOwnerLabel, duoOwnerUserIdOf, duoUserIdFor, isDuoUserId, localpartOf } from "../src/workspace/identity.js";

/*
 * #62: the workspace's user-id grammar, mirrored from the core's
 * identity/directory module (digital-duo #187): a duo's Matrix user id is
 * `@duo-<owner-localpart>:<server>` beside the owner's `@<owner-localpart>`,
 * and the derivation is a bijection by construction. The client renders
 * attribution from this structure — never from display names, which are
 * self-service claims a sender can set to anything.
 */
describe("workspace identity grammar (mirrors digital-duo #187)", () => {
  it("recognizes duo-shaped ids, and only duo-shaped ones", () => {
    expect(isDuoUserId("@duo-alice:workspace.example")).toBe(true);
    expect(isDuoUserId("@alice:workspace.example")).toBe(false);
    // The namespace is reserved by the convention: a person whose localpart
    // happens to start with `duo-` is indistinguishable from a duo and the
    // directory says so by exclusion — mirrored, not "fixed".
    expect(isDuoUserId("@duo-carol:workspace.example")).toBe(true);
    expect(isDuoUserId("not-an-id")).toBe(false);
    expect(isDuoUserId("@duo-alice")).toBe(false);
  });

  it("derives a person's duo id, and nothing for an unshapely id", () => {
    expect(duoUserIdFor("@alice:workspace.example")).toBe("@duo-alice:workspace.example");
    expect(duoUserIdFor("alice")).toBeNull();
  });

  it("derives a duo's owner back, and nothing for a plain person", () => {
    expect(duoOwnerUserIdOf("@duo-alice:workspace.example")).toBe("@alice:workspace.example");
    expect(duoOwnerUserIdOf("@alice:workspace.example")).toBeNull();
    expect(duoOwnerUserIdOf("@duo-bob:other.example")).toBe("@bob:other.example");
  });

  it("extracts the localpart, passing unshapely ids through to fail safely", () => {
    expect(localpartOf("@alice:workspace.example")).toBe("alice");
    expect(localpartOf("alice")).toBe("alice");
  });

  it("labels a duo's message with its owner's localpart — structural, never a display name", () => {
    expect(duoOwnerLabel("@duo-alice:workspace.example")).toBe("alice");
    expect(duoOwnerLabel("@alice:workspace.example")).toBeNull();
  });
});
