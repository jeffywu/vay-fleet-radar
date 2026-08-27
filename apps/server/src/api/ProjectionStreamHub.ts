import type pg from "pg";
import { ProjectionUpdateRepository } from "../database/ProjectionUpdateRepository.ts";
import type { ProjectionUpdate } from "../database/types.ts";

type StreamClient = { cursor: bigint; sending: Promise<void>; send: (update: ProjectionUpdate) => Promise<void>; close: () => void };

export class ProjectionStreamHub {
  private listener?: pg.PoolClient;
  private poll?: NodeJS.Timeout;
  private pruneTimer?: NodeJS.Timeout;
  private readonly clients = new Set<StreamClient>();
  private waking = false;
  constructor(private readonly pool: pg.Pool, private readonly updates: ProjectionUpdateRepository,
    private readonly pollMs: number, private readonly pageSize: number, private readonly retentionRows = 10_000,
    private readonly retentionHours = 24) {}

  async start(): Promise<void> {
    await this.ensureListener();
    this.poll = setInterval(() => void this.wake(), this.pollMs);
    this.poll.unref();
    this.pruneTimer = setInterval(() => void this.updates.prune(this.pool, this.retentionRows, this.retentionHours).catch(() => undefined), 60_000);
    this.pruneTimer.unref();
  }
  attach(cursor: string, send: (update: ProjectionUpdate) => Promise<void>, close: () => void): () => void {
    const client: StreamClient = { cursor: BigInt(cursor), sending: Promise.resolve(), send, close };
    this.clients.add(client);
    void this.pump(client);
    return () => this.clients.delete(client);
  }
  async stop(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.poll = undefined;
    this.pruneTimer = undefined;
    for (const client of this.clients) client.close();
    this.clients.clear();
    if (this.listener) {
      const listener = this.listener;
      this.listener = undefined;
      await listener.query("UNLISTEN projection_updates").catch(() => undefined);
      listener.release();
    }
  }
  private async ensureListener(): Promise<void> {
    if (this.listener) return;
    const listener = await this.pool.connect();
    await listener.query("LISTEN projection_updates");
    listener.on("notification", () => void this.wake());
    listener.on("error", () => { if (this.listener === listener) this.listener = undefined; listener.release(true); });
    this.listener = listener;
  }
  private async wake(): Promise<void> {
    if (this.waking) return;
    this.waking = true;
    try {
      await this.ensureListener().catch(() => undefined);
      await Promise.all([...this.clients].map((client) => this.pump(client)));
    } finally { this.waking = false; }
  }
  private async pump(client: StreamClient): Promise<void> {
    client.sending = client.sending.then(async () => {
      while (this.clients.has(client)) {
        const rows = await this.updates.readAfter(this.pool, client.cursor.toString(), this.pageSize);
        if (!rows.length) return;
        for (const row of rows) {
          if (BigInt(row.streamId) <= client.cursor) continue;
          await client.send(row);
          client.cursor = BigInt(row.streamId);
        }
        if (rows.length < this.pageSize) return;
      }
    }).catch(() => { this.clients.delete(client); client.close(); });
    await client.sending;
  }
}
