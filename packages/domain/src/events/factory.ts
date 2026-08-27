import type { CreateFleetEventInput, FleetEventFactory } from "./ports.ts";
import type { FleetEvent, FleetEventType } from "./types.ts";

export class SequencedFleetEventFactory implements FleetEventFactory {
  private readonly sequenceByVehicle = new Map<string, number>();

  constructor(
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  create<TType extends FleetEventType>(input: CreateFleetEventInput<TType>): FleetEvent<TType> {
    const sequence = (this.sequenceByVehicle.get(input.vehicleId) ?? 0) + 1;
    this.sequenceByVehicle.set(input.vehicleId, sequence);
    return {
      eventId: this.createId(),
      eventType: input.eventType,
      schemaVersion: 1,
      vehicleId: input.vehicleId,
      sequence,
      occurredAt: input.occurredAt ?? this.now().toISOString(),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      payload: input.payload,
    };
  }
}
