import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "../src/api.js";

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { f, calls };
}

describe("api client", () => {
  it("sends JSON and encodes path parts", async () => {
    const { f, calls } = fakeFetch(() => ({ body: { view: { step: "why" }, answer: null } }));
    const api = createApi(f, "http://x");
    const r = await api.answer("int 1", "why", ["fun"]);
    expect(r.view.step).toBe("why");
    expect(calls[0].url).toBe("http://x/api/intake/int%201/answer");
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ field: "why", value: ["fun"] });
  });
  it("turns server errors into ApiError with the server's message and data", async () => {
    const { f } = fakeFetch(() => ({ status: 400, body: { ok: false, error: "Needs consent.", data: { needsConsent: true, runner: "local" } } }));
    const api = createApi(f);
    const e = await api.codeRun({ spec: {}, files: {} }).catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.message).toBe("Needs consent.");
    expect(e.data).toEqual({ needsConsent: true, runner: "local" });
  });
  it("treats {ok:false} bodies as errors even with 200", async () => {
    const { f } = fakeFetch(() => ({ body: { ok: false, error: "nope" } }));
    await expect(createApi(f).pairClaim("t")).rejects.toThrow("nope");
  });
  it("reports an unreachable server plainly", async () => {
    const api = createApi(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(api.health()).rejects.toThrow(/Can't reach the LAS server/);
  });
  it("uploads media with its own content type", async () => {
    const { f, calls } = fakeFetch(() => ({ body: { ok: true, mediaRef: "/m" } }));
    await createApi(f).uploadMedia("att_1", new Blob(["x"], { type: "video/webm" }));
    expect((calls[0].init?.headers as Record<string, string>)["content-type"]).toBe("video/webm");
  });
});
