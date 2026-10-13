import { describe, expect, it } from "vitest";
import { buildPath, matchRoute, ROUTES } from "../src/router.js";

describe("router", () => {
  it("matches every studio route with params and query", () => {
    expect(matchRoute("/")?.name).toBe("home");
    expect(matchRoute("/app/onboard/new")?.name).toBe("onboard-new");
    expect(matchRoute("/app/onboard/int_1")).toMatchObject({ name: "onboard", params: { intakeId: "int_1" } });
    const t = matchRoute("/app/today", "?sk=enr_1")!;
    expect(t.name).toBe("today");
    expect(t.query.get("sk")).toBe("enr_1");
    expect(matchRoute("/app/session/ses_9/")?.params.id).toBe("ses_9");
    expect(matchRoute("/s/ses_9")?.name).toBe("session");
    expect(matchRoute("/pair/pair_x")?.params.token).toBe("pair_x");
    expect(matchRoute("/snapshots", "?theme=glass&screen=lesson")?.query.get("screen")).toBe("lesson");
    expect(matchRoute("/nope/at/all")).toBeUndefined();
    expect(matchRoute("/app/capture/a%2Fb")?.params.attemptId).toBe("a/b");
  });
  it("builds paths with encoded params and only the query values given", () => {
    expect(buildPath("/app/session/:id", { id: "ses 1" }, { step: 3, empty: "", none: undefined })).toBe("/app/session/ses%201?step=3");
    expect(buildPath("/app/today", {}, { sk: "e1" })).toBe("/app/today?sk=e1");
    for (const [pattern] of ROUTES) expect(matchRoute(buildPath(pattern, { intakeId: "i", id: "x", attemptId: "a", sessionId: "s", milestoneId: "m", token: "t" }))).toBeDefined();
  });
});
