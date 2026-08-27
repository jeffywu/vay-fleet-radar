// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFleetEventSource, fetchFleetSnapshot } from "../api/fleetApi.ts";

const validSnapshot = { data: [], meta: { count: 0, generatedAt: "2026-01-01T00:00:00.000Z", streamCursor: "7", staleAfterSeconds: 30 } };

describe("fleetApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests the same-origin snapshot with cancellation", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(validSnapshot), {
      status: 200, headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFleetSnapshot(controller.signal)).resolves.toEqual(validSnapshot);
    expect(fetchMock).toHaveBeenCalledWith("/api/vehicles", { signal: controller.signal, headers: { Accept: "application/json" } });
  });

  it("returns safe errors for non-success and malformed responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("no", { status: 503 }))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 })));
    await expect(fetchFleetSnapshot(new AbortController().signal)).rejects.toThrow("snapshot could not be loaded");
    await expect(fetchFleetSnapshot(new AbortController().signal)).rejects.toThrow("invalid response");
  });

  it("opens a named-event stream after the supplied opaque cursor", () => {
    const eventSource = { addEventListener: vi.fn(), close: vi.fn() };
    const constructor = vi.fn(() => eventSource);
    vi.stubGlobal("EventSource", constructor);
    expect(createFleetEventSource("9007199254740993")).toBe(eventSource);
    expect(constructor).toHaveBeenCalledWith("/api/events?after=9007199254740993");
  });
});
