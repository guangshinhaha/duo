import { describe, expect, it } from "vitest";
import { canonicalHash, isLegacyHash, roomOfRoute, routeFromHash } from "../src/shell/routes.js";

describe("the chat-first address grammar (#141)", () => {
  it("home is the chat list, and an empty or unknown address falls back to the shell's default", () => {
    expect(routeFromHash("#chats")).toBe("chats");
    expect(routeFromHash("")).toBe("chats");
    expect(routeFromHash("#nonsense", "duo")).toBe("duo");
  });

  it("a chat, an event in it, and a thread each have one address, encoded whole", () => {
    expect(routeFromHash("#chat/!r%3Aw.example")).toEqual({ chat: "!r:w.example" });
    expect(routeFromHash("#chat/!r%3Aw.example/%24ev1")).toEqual({ chat: "!r:w.example", at: "$ev1" });
    expect(routeFromHash("#chat/!r%3Aw.example/thread/%24root/%24reply")).toEqual({
      thread: { roomId: "!r:w.example", rootEventId: "$root", at: "$reply" },
    });
    for (const route of [
      { chat: "!r:w.example" },
      { chat: "!r:w.example", at: "$ev1" },
      { thread: { roomId: "!r:w.example", rootEventId: "$root" } },
      { thread: { roomId: "!r:w.example", rootEventId: "$root", at: "$reply" } },
    ] as const) {
      expect(routeFromHash(canonicalHash(route))).toEqual(route);
    }
  });

  it("the duo's profile has five tabs, and an unknown tab is the portrait", () => {
    for (const tab of ["portrait", "knows", "may", "rules", "activity"] as const) {
      expect(routeFromHash(`#duo/profile/${tab}`)).toEqual({ profile: tab });
    }
    expect(routeFromHash("#duo/profile")).toEqual({ profile: "portrait" });
    expect(routeFromHash("#duo/profile/nope")).toEqual({ profile: "portrait" });
  });

  it("every retired address lands on its new home", () => {
    const home: Record<string, string> = {
      "#review": "waiting",
      "#conversations": "chats",
    };
    for (const [old, name] of Object.entries(home)) {
      expect(routeFromHash(old)).toBe(name);
    }
    expect(routeFromHash("#corrections")).toEqual({ profile: "rules" });
    expect(routeFromHash("#mirror")).toEqual({ profile: "portrait" });
    expect(routeFromHash("#knowledge")).toEqual({ profile: "knows" });
    expect(routeFromHash("#channels")).toEqual({ profile: "knows" });
    expect(routeFromHash("#trust")).toEqual({ profile: "may" });
    expect(routeFromHash("#audit")).toEqual({ profile: "activity" });
    expect(routeFromHash("#escalations")).toEqual({ profile: "activity" });
    expect(routeFromHash("#room/!r%3Aw.example")).toEqual({ chat: "!r:w.example" });
    expect(routeFromHash("#room/!r%3Aw.example/%24ev")).toEqual({ chat: "!r:w.example", at: "$ev" });
    expect(routeFromHash("#thread/!r%3Aw.example/%24root")).toEqual({ thread: { roomId: "!r:w.example", rootEventId: "$root" } });
  });

  it("a draft's own address stays, and admin keeps its two forms", () => {
    expect(routeFromHash("#draft/abc")).toEqual({ draft: "abc" });
    expect(routeFromHash("#admin")).toBe("admin");
    expect(routeFromHash("#admin/plat1")).toEqual({ adminOrg: "plat1" });
    expect(routeFromHash("#settings")).toBe("settings");
  });

  it("#222: mentions is its own plain address, separate from waiting", () => {
    expect(routeFromHash("#mentions")).toBe("mentions");
    expect(canonicalHash("mentions")).toBe("#mentions");
    expect(routeFromHash("#mentions")).not.toBe(routeFromHash("#waiting"));
  });

  it("settings is an index and one address per section; an unknown section is the index", () => {
    for (const id of ["notifications", "appearance", "devices", "links", "claude", "advanced", "end"] as const) {
      expect(routeFromHash(`#settings/${id}`)).toEqual({ settings: id });
      expect(routeFromHash(canonicalHash({ settings: id }))).toEqual({ settings: id });
    }
    expect(routeFromHash("#settings/nonsense")).toBe("settings");
    expect(routeFromHash("#settings/")).toBe("settings");
  });

  it("only retired addresses are marked for in-place rewriting", () => {
    expect(isLegacyHash("#review")).toBe(true);
    expect(isLegacyHash("#room/x")).toBe(true);
    expect(isLegacyHash("#chat/x")).toBe(false);
    expect(isLegacyHash("#chats")).toBe(false);
    expect(isLegacyHash("#draft/x")).toBe(false);
  });

  it("names the room a route is about, and none for the rest", () => {
    expect(roomOfRoute({ chat: "!a" })).toBe("!a");
    expect(roomOfRoute({ thread: { roomId: "!b", rootEventId: "$r" } })).toBe("!b");
    expect(roomOfRoute("duo")).toBeNull();
    expect(roomOfRoute({ profile: "may" })).toBeNull();
  });
});
