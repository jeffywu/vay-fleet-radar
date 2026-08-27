import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORLD_SEED,
  LAS_VEGAS_BOUNDS,
  generateWorld,
  hasMinimumSeparation,
  seededRandom,
  serviceZoneIdFor,
  validateWorld,
  type WorldData,
} from "../src/index.ts";
import { loadWorldCatalog } from "../src/load.ts";
import { parseArguments, serializeWorld } from "../../../tools/generate-world.ts";

function cloneWorld(): WorldData {
  const generated = generateWorld();
  return structuredClone({
    serviceArea: generated.serviceArea,
    serviceZones: generated.serviceZones,
    destinations: generated.destinations,
  });
}

describe("seeded generation", () => {
  it("rejects missing CLI option values", () => {
    expect(() => parseArguments(["--seed"])).toThrow(/--seed requires/);
    expect(() => parseArguments(["--output"])).toThrow(/--output requires/);
  });

  it("repeats a pseudorandom sequence for the same seed", () => {
    const left = seededRandom("repeatable");
    const right = seededRandom("repeatable");
    expect([left(), left(), left()]).toEqual([right(), right(), right()]);
  });

  it("produces byte-identical output for one seed and changed coordinates for another", () => {
    const first = serializeWorld(generateWorld(DEFAULT_WORLD_SEED));
    const second = serializeWorld(generateWorld(DEFAULT_WORLD_SEED));
    const alternate = serializeWorld(generateWorld("another-seed"));
    expect(first).toEqual(second);
    expect(first["destinations.json"]).not.toBe(alternate["destinations.json"]);
    expect(JSON.parse(alternate["destinations.json"])).toHaveLength(200);
  });

  it("keeps candidates at least 75 meters apart", () => {
    expect(hasMinimumSeparation([-115.15, 36.15], [[-115.15, 36.15]], 75)).toBe(false);
    expect(hasMinimumSeparation([-115.15, 36.151], [[-115.15, 36.15]], 75)).toBe(true);
  });

  it("matches the committed default asset hash", () => {
    const files = serializeWorld(generateWorld());
    const digest = createHash("sha256")
      .update(files["service-area.geojson"])
      .update(files["service-zones.geojson"])
      .update(files["destinations.json"])
      .digest("hex");
    expect(digest).toBe("622097c9bbaea7088c644d49a289596524139c0a317ea4e53c388d5647c83bba");
  });
});

describe("zone assignment", () => {
  const longitudeStep = (LAS_VEGAS_BOUNDS.east - LAS_VEGAS_BOUNDS.west) / 3;
  const latitudeStep = (LAS_VEGAS_BOUNDS.north - LAS_VEGAS_BOUNDS.south) / 3;

  it("uses the configured north/east tie-break on shared boundaries", () => {
    expect(serviceZoneIdFor([LAS_VEGAS_BOUNDS.west + longitudeStep, LAS_VEGAS_BOUNDS.south + latitudeStep])).toBe("zone-c");
    expect(serviceZoneIdFor([LAS_VEGAS_BOUNDS.west + 2 * longitudeStep, LAS_VEGAS_BOUNDS.south + 2 * latitudeStep])).toBe("zone-ne");
  });

  it("rejects coordinates outside the service area", () => {
    expect(() => serviceZoneIdFor([-120, 36])).toThrow(/outside the service area/);
  });
});

describe("world validation", () => {
  it("accepts the generated world", () => expect(() => validateWorld(cloneWorld())).not.toThrow());

  it.each([
    ["open service-area ring", (world: WorldData) => ((world.serviceArea.geometry.coordinates[0] as number[][])[4] = [-115, 36]), /ring must be closed/],
    ["missing zone", (world: WorldData) => ((world.serviceZones.features as unknown[]).pop()), /exactly nine/],
    ["mis-sized zone", (world: WorldData) => {
      const ring = world.serviceZones.features[0].geometry.coordinates[0] as number[][];
      ring[1][0] -= 0.01;
      ring[2][0] -= 0.01;
    }, /does not tile its configured grid cell/],
    ["duplicate id", (world: WorldData) => ((world.destinations[1] as { id: string }).id = world.destinations[0].id), /duplicate destination id/],
    ["duplicate name", (world: WorldData) => ((world.destinations[1] as { name: string }).name = world.destinations[0].name), /duplicate destination name/],
    ["outside coordinate", (world: WorldData) => ((world.destinations[0] as { coordinate: number[] }).coordinate = [-120, 36]), /outside the service area/],
    ["wrong zone", (world: WorldData) => ((world.destinations[0] as { serviceZoneId: string }).serviceZoneId = "zone-ne"), /belongs to/],
    ["near duplicate", (world: WorldData) => {
      (world.destinations[1] as { coordinate: number[] }).coordinate = [...world.destinations[0].coordinate];
      (world.destinations[1] as { serviceZoneId: string }).serviceZoneId = world.destinations[0].serviceZoneId;
    }, /are 0.0m apart/],
  ])("rejects %s", (_label, mutate, expected) => {
    const world = cloneWorld();
    mutate(world);
    expect(() => validateWorld(world)).toThrow(expected);
  });
});

describe("WorldCatalog", () => {
  it("loads the canonical immutable world once into indexed memory", async () => {
    const catalog = await loadWorldCatalog();
    expect(catalog.destinations).toHaveLength(200);
    expect(catalog.serviceZones).toHaveLength(9);
    expect(catalog.getDestination("dst-lv-0200")?.name).toBe("LV Destination 200");
    expect(catalog.getServiceZone("zone-c")?.properties.id).toBe("zone-c");
    expect(Object.isFrozen(catalog.destinations)).toBe(true);
    expect(Object.isFrozen(catalog.destinations[0])).toBe(true);
  });

  it("reports a missing source file with its role and path", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "fleet-world-missing-"));
    await expect(loadWorldCatalog({
      serviceArea: resolve(directory, "missing-area.json"),
      serviceZones: resolve(directory, "missing-zones.json"),
      destinations: resolve(directory, "missing-destinations.json"),
    })).rejects.toThrow(/Unable to load (service area|service zones|destinations).*missing-/);
  });

  it("reports invalid source data as a startup error", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "fleet-world-invalid-"));
    const files = serializeWorld(generateWorld());
    const area = resolve(directory, "area.json");
    const zones = resolve(directory, "zones.json");
    const destinations = resolve(directory, "destinations.json");
    await Promise.all([
      writeFile(area, files["service-area.geojson"]),
      writeFile(zones, files["service-zones.geojson"]),
      writeFile(destinations, "[]\n"),
    ]);
    await expect(loadWorldCatalog({ serviceArea: area, serviceZones: zones, destinations })).rejects.toThrow(/exactly 200 destinations/);
  });
});
