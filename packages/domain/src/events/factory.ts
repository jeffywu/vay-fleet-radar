import type { CreateFleetEventInput, FleetEventFactory } from "./ports.ts";
import type { FleetEvent, FleetEventType } from "./types.ts";

export class SequencedFleetEventFactory implements FleetEventFactory {
  private readonly sequenceByVehicle = new Map<string, number>();

  constructor(
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  initializeSequences(sequences: Iterable<readonly [string, number]>): void {
    for (const [vehicleId, sequence] of sequences) {
      if (typeof vehicleId !== "string" || vehicleId.trim().length === 0) {
        throw new TypeError("Sequence vehicleId must be a non-empty string");
      }
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new TypeError(`Sequence for ${vehicleId} must be a non-negative safe integer`);
      }
      const current = this.sequenceByVehicle.get(vehicleId) ?? 0;
      if (sequence < current) {
        throw new RangeError(`Cannot move sequence for ${vehicleId} backwards from ${current} to ${sequence}`);
      }
      this.sequenceByVehicle.set(vehicleId, sequence);
    }
  }

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
