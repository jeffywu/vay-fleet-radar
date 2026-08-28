import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { resetSimulationState } from "../src/database/resetSimulationState.ts";

describe("resetSimulationState", () => {
  it("clears only runtime simulation tables without reusing durable stream cursors", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    await resetSimulationState({ query } as unknown as pg.Pool);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain(
      "TRUNCATE projection_update,dispatch_job,route_current,vehicle_current,vehicle_projection_cursor,event_log CASCADE",
    );
    expect(query.mock.calls[0]?.[0]).not.toContain("RESTART IDENTITY");
    expect(query.mock.calls[0]?.[0]).not.toContain("pgmigrations");
  });
});
