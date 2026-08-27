exports.up = (pgm) => {
  pgm.createTable("projection_update", {
    stream_id: { type: "bigserial", primaryKey: true },
    event_id: { type: "text", notNull: true, references: "event_log", onDelete: "CASCADE" },
    update_type: { type: "text", notNull: true, check: "update_type IN ('vehicle.updated','route.updated','route.removed','dispatch-job.updated')" },
    aggregate_id: { type: "text", notNull: true },
    payload: { type: "jsonb", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("clock_timestamp()") },
  });
  pgm.addConstraint("projection_update", "projection_update_event_aggregate_unique", {
    unique: ["event_id", "update_type", "aggregate_id"],
  });
  pgm.createIndex("projection_update", "created_at");
};

exports.down = (pgm) => pgm.dropTable("projection_update");
