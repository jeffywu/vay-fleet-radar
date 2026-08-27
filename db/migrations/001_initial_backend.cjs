exports.up = (pgm) => {
  pgm.createTable("event_log", {
    ingest_id: { type: "bigserial", notNull: true, unique: true },
    event_id: { type: "text", primaryKey: true },
    event_type: { type: "text", notNull: true },
    schema_version: { type: "smallint", notNull: true },
    vehicle_id: { type: "text", notNull: true },
    sequence: { type: "bigint", notNull: true, check: "sequence > 0" },
    occurred_at: { type: "timestamptz", notNull: true },
    received_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
    correlation_id: { type: "text" },
    payload: { type: "jsonb", notNull: true },
  });
  pgm.createIndex("event_log", ["vehicle_id", "sequence"]);
  pgm.createIndex("event_log", [{ name: "received_at", sort: "DESC" }]);
  pgm.createIndex("event_log", ["event_type", { name: "received_at", sort: "DESC" }]);
  pgm.createIndex("event_log", "correlation_id", { where: "correlation_id IS NOT NULL" });

  pgm.createTable("vehicle_projection_cursor", {
    vehicle_id: { type: "text", primaryKey: true },
    last_sequence: { type: "bigint", notNull: true },
    last_event_id: { type: "text", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.createTable("vehicle_current", {
    vehicle_id: { type: "text", primaryKey: true },
    longitude: { type: "double precision", notNull: true, check: "longitude BETWEEN -180 AND 180" },
    latitude: { type: "double precision", notNull: true, check: "latitude BETWEEN -90 AND 90" },
    heading: { type: "double precision", notNull: true, check: "heading >= 0 AND heading < 360" },
    battery_percentage: { type: "double precision", notNull: true, check: "battery_percentage BETWEEN 0 AND 100" },
    status: { type: "text", notNull: true, check: "status IN ('FREE','WITH_CUSTOMER','EN_ROUTE')" },
    service_zone_id: { type: "text", notNull: true },
    last_telemetry_sequence: { type: "bigint", notNull: true },
    last_occurred_at: { type: "timestamptz", notNull: true },
    last_received_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.createIndex("vehicle_current", "status");
  pgm.createIndex("vehicle_current", "service_zone_id");
  pgm.createIndex("vehicle_current", "last_received_at");

  pgm.createTable("route_current", {
    vehicle_id: { type: "text", primaryKey: true },
    route_id: { type: "text", notNull: true, unique: true },
    version: { type: "integer", notNull: true, check: "version > 0" },
    destination_id: { type: "text", notNull: true },
    dispatch_job_id: { type: "text" },
    state: { type: "text", notNull: true, check: "state IN ('ACCEPTED','IN_PROGRESS')" },
    origin_longitude: { type: "double precision" },
    origin_latitude: { type: "double precision" },
    last_event_sequence: { type: "bigint", notNull: true },
    assigned_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.createTable("dispatch_job", {
    dispatch_job_id: { type: "text", primaryKey: true },
    vehicle_id: { type: "text", notNull: true },
    route_id: { type: "text", notNull: true },
    route_version: { type: "integer", notNull: true, check: "route_version > 0" },
    destination_id: { type: "text", notNull: true },
    strategy: { type: "text", notNull: true },
    decision_reason: { type: "text" },
    command_id: { type: "text", notNull: true, unique: true },
    correlation_id: { type: "text", notNull: true },
    state: { type: "text", notNull: true, check: "state IN ('REQUESTED','ACCEPTED','IN_PROGRESS','COMPLETED','REJECTED','CANCELLED','FAILED')" },
    requested_at: { type: "timestamptz", notNull: true },
    accepted_at: { type: "timestamptz" },
    started_at: { type: "timestamptz" },
    completed_at: { type: "timestamptz" },
    updated_at: { type: "timestamptz", notNull: true },
  });
  pgm.createIndex("dispatch_job", "vehicle_id", {
    unique: true,
    name: "dispatch_job_one_active_per_vehicle",
    where: "state IN ('REQUESTED','ACCEPTED','IN_PROGRESS')",
  });
  pgm.createIndex("dispatch_job", [{ name: "updated_at", sort: "DESC" }, "dispatch_job_id"]);
};

exports.down = (pgm) => {
  pgm.dropTable("dispatch_job");
  pgm.dropTable("route_current");
  pgm.dropTable("vehicle_current");
  pgm.dropTable("vehicle_projection_cursor");
  pgm.dropTable("event_log");
};
