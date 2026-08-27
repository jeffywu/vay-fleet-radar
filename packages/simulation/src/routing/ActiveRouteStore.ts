import type { LineString } from "geojson";

export type ActiveRouteView = {
  readonly routeId: string;
  readonly vehicleId: string;
  readonly routeVersion: number;
  readonly destinationId: string;
  readonly purpose: "CUSTOMER" | "DISPATCH";
  readonly geometry: LineString;
};

export interface ActiveRouteReader {
  get(routeId: string): ActiveRouteView | undefined;
  listDispatchRoutes(): readonly ActiveRouteView[];
}

export class ActiveRouteStore implements ActiveRouteReader {
  private readonly routes = new Map<string, ActiveRouteView>();
  set(route: ActiveRouteView): void { this.routes.set(route.routeId, structuredClone(route)); }
  delete(routeId: string): void { this.routes.delete(routeId); }
  clear(): void { this.routes.clear(); }
  get(routeId: string): ActiveRouteView | undefined {
    const route = this.routes.get(routeId);
    return route ? structuredClone(route) : undefined;
  }
  listDispatchRoutes(): readonly ActiveRouteView[] {
    return [...this.routes.values()].filter(({ purpose }) => purpose === "DISPATCH").map((route) => structuredClone(route));
  }
}
