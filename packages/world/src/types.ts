export type Coordinate = readonly [longitude: number, latitude: number];

export type PolygonFeature = {
  readonly type: "Feature";
  readonly properties: Readonly<Record<string, unknown>> & {
    readonly id: string;
    readonly name: string;
  };
  readonly geometry: {
    readonly type: "Polygon";
    readonly coordinates: readonly (readonly Coordinate[])[];
  };
};

export type PolygonFeatureCollection = {
  readonly type: "FeatureCollection";
  readonly features: readonly PolygonFeature[];
};

export type Destination = {
  readonly id: string;
  readonly name: string;
  readonly coordinate: Coordinate;
  readonly serviceZoneId: string;
};

export type WorldData = {
  readonly serviceArea: PolygonFeature;
  readonly serviceZones: PolygonFeatureCollection;
  readonly destinations: readonly Destination[];
};

export type WorldCatalogView = {
  readonly serviceArea: PolygonFeature;
  readonly serviceZones: readonly PolygonFeature[];
  readonly destinations: readonly Destination[];
  getServiceZone(id: string): PolygonFeature | undefined;
  getDestination(id: string): Destination | undefined;
};

