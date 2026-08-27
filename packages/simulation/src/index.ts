import type { Coordinate, Destination, WorldCatalogView } from "@fleet-radar/world";

export type PlannedRoute = {
  readonly geometry: readonly Coordinate[];
  readonly distanceMeters: number;
  readonly durationSeconds: number;
};

export type RoutingPort = {
  route(origin: Coordinate, destination: Coordinate): Promise<PlannedRoute>;
};

export type SimulatedTrip = {
  readonly destination: Destination;
  readonly route: PlannedRoute;
};

export async function startSimulatedTrip(
  origin: Coordinate,
  world: WorldCatalogView,
  routing: RoutingPort,
  random: () => number,
): Promise<SimulatedTrip> {
  if (world.destinations.length === 0) throw new Error("Cannot start a trip without world destinations");
  const index = Math.min(world.destinations.length - 1, Math.floor(random() * world.destinations.length));
  const destination = world.destinations[index];
  return { destination, route: await routing.route(origin, destination.coordinate) };
}

