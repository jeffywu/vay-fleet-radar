import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Destination, PolygonFeature, WorldCatalogView } from "./types.ts";
import { parseWorldData } from "./validate.ts";

export type WorldFilePaths = {
  readonly serviceArea: string;
  readonly serviceZones: string;
  readonly destinations: string;
};

export function defaultWorldPaths(repositoryRoot = process.cwd()): WorldFilePaths {
  return {
    serviceArea: resolve(repositoryRoot, "assets/world/service-area.geojson"),
    serviceZones: resolve(repositoryRoot, "assets/world/service-zones.geojson"),
    destinations: resolve(repositoryRoot, "assets/world/destinations.json"),
  };
}

async function readJson(path: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load ${label} from ${path}: ${detail}`, { cause: error });
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export class WorldCatalog implements WorldCatalogView {
  readonly serviceArea: PolygonFeature;
  readonly serviceZones: readonly PolygonFeature[];
  readonly destinations: readonly Destination[];
  readonly #zonesById: ReadonlyMap<string, PolygonFeature>;
  readonly #destinationsById: ReadonlyMap<string, Destination>;

  constructor(world: ReturnType<typeof parseWorldData>) {
    this.serviceArea = deepFreeze(world.serviceArea);
    this.serviceZones = deepFreeze([...world.serviceZones.features]);
    this.destinations = deepFreeze([...world.destinations]);
    this.#zonesById = new Map(this.serviceZones.map((zone) => [zone.properties.id, zone]));
    this.#destinationsById = new Map(this.destinations.map((destination) => [destination.id, destination]));
    Object.freeze(this);
  }

  getServiceZone(id: string): PolygonFeature | undefined {
    return this.#zonesById.get(id);
  }

  getDestination(id: string): Destination | undefined {
    return this.#destinationsById.get(id);
  }
}

export async function loadWorldCatalog(paths = defaultWorldPaths()): Promise<WorldCatalog> {
  const [serviceArea, serviceZones, destinations] = await Promise.all([
    readJson(paths.serviceArea, "service area"),
    readJson(paths.serviceZones, "service zones"),
    readJson(paths.destinations, "destinations"),
  ]);
  try {
    return new WorldCatalog(parseWorldData(serviceArea, serviceZones, destinations));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to initialize WorldCatalog: ${detail}`, { cause: error });
  }
}

