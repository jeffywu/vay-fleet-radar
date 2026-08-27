import type pg from "pg";
import type { AnyFleetEvent, EventSource, Unsubscribe } from "@fleet-radar/domain/events";
import { parseFleetEvent } from "@fleet-radar/domain/events";
import { EventStore } from "../database/EventStore.ts";
import { inTransaction } from "../database/transaction.ts";
import { ProjectionReducer } from "./ProjectionReducer.ts";

export type ConsumeResult = { disposition: "DUPLICATE" | "APPLIED" | "STALE" | "NO_OP"; receivedAt?: string; streamIds: readonly string[] };

export class PostgresFleetEventConsumer {
  private unsubscribe?: Unsubscribe;
  private state: "stopped" | "ready" | "failed" = "stopped";
  private chain = Promise.resolve();
  constructor(private readonly source: EventSource, private readonly pool: pg.Pool, private readonly reducer: ProjectionReducer,
    private readonly store = new EventStore(), private readonly now: () => Date = () => new Date()) {}

  status(): "stopped" | "ready" | "failed" { return this.state; }
  async start(): Promise<void> {
    if (this.unsubscribe) return;
    this.unsubscribe = await this.source.subscribe((event) => {
      const next = this.chain.then(() => this.consume(event));
      this.chain = next.then(() => undefined, () => undefined);
      return next.then(() => undefined);
    });
    this.state = "ready";
  }
  async stop(): Promise<void> {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    await unsubscribe?.();
    await this.chain;
    this.state = "stopped";
  }
  async consume(input: AnyFleetEvent | unknown, receivedAtOverride?: string): Promise<ConsumeResult> {
    const event = parseFleetEvent(input);
    try {
      return await inTransaction(this.pool, async (client) => {
        const appended = await this.store.append(client, event, receivedAtOverride ?? this.now().toISOString());
        if (!appended) return { disposition: "DUPLICATE", streamIds: [] };
        const projected = await this.reducer.apply(client, event, appended.receivedAt);
        if (projected.streamIds.length) await client.query("SELECT pg_notify('projection_updates',$1)", [projected.streamIds.at(-1)]);
        return { ...projected, receivedAt: appended.receivedAt };
      });
    } catch (error) { this.state = "failed"; throw error; }
  }
}
