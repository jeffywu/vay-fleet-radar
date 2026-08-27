import type { AnyFleetEvent, FleetEvent, FleetEventType } from "./types.ts";

export type FleetEventHandler = (event: AnyFleetEvent) => Promise<void>;
export type Unsubscribe = () => Promise<void>;

export interface EventSource {
  subscribe(handler: FleetEventHandler): Promise<Unsubscribe>;
}

export interface EventPublisher {
  /** Resolves only after all current subscribers handle the event; rejects explicitly on delivery failure. */
  publish(event: AnyFleetEvent): Promise<void>;
}

export type CreateFleetEventInput<TType extends FleetEventType> = {
  readonly eventType: TType;
  readonly vehicleId: string;
  readonly payload: FleetEvent<TType>["payload"];
  readonly occurredAt?: string;
  readonly correlationId?: string;
};

export interface FleetEventFactory {
  /** Hydrates the last accepted sequence for each vehicle before producers start. */
  initializeSequences(sequences: Iterable<readonly [vehicleId: string, sequence: number]>): void;
  create<TType extends FleetEventType>(input: CreateFleetEventInput<TType>): FleetEvent<TType>;
}
