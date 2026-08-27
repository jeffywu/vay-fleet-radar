import type { AnyFleetEvent, EventPublisher, EventSource, FleetEventHandler, Unsubscribe } from "@fleet-radar/domain/events";
import { validateFleetEvent } from "@fleet-radar/domain/events";

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Process-local transport adapter. Publishes are queued in call order, which
 * preserves per-vehicle order when producers publish their sequenced events in order.
 */
export class InMemoryEventBus implements EventPublisher, EventSource {
  private readonly subscribers = new Map<number, FleetEventHandler>();
  private nextSubscriberId = 1;
  private tail: Promise<void> = Promise.resolve();

  async subscribe(handler: FleetEventHandler): Promise<Unsubscribe> {
    const id = this.nextSubscriberId++;
    this.subscribers.set(id, handler);
    let subscribed = true;
    return async () => {
      if (!subscribed) return;
      subscribed = false;
      this.subscribers.delete(id);
    };
  }

  publish(event: AnyFleetEvent): Promise<void> {
    validateFleetEvent(event);
    // Mimic a serialization boundary so later producer mutations cannot change
    // a record that the transport has already accepted.
    const acceptedEvent = deepFreeze(structuredClone(event));
    // Capture subscribers at publish time. Unsubscribing stops later publishes,
    // while records already accepted by the bus are still delivered.
    const subscribers = [...this.subscribers.values()];
    const delivery = this.tail.then(async () => {
      const results = await Promise.allSettled(subscribers.map((handler) => handler(acceptedEvent)));
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, `Failed to deliver fleet event ${acceptedEvent.eventId}`);
    });
    // A failed handler rejects that publish, but must not poison subsequent deliveries.
    this.tail = delivery.then(() => undefined, () => undefined);
    return delivery;
  }

  /** Waits until all records accepted so far have finished delivery. */
  async flush(): Promise<void> {
    await this.tail;
  }
}
