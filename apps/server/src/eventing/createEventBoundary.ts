import { SequencedFleetEventFactory } from "@fleet-radar/domain/events";
import { DispatchEventEmitter } from "@fleet-radar/dispatch";
import { SimulationEventEmitter } from "@fleet-radar/simulation";
import { FleetProjectionConsumer } from "./FleetProjectionConsumer.ts";
import { InMemoryEventBus } from "./InMemoryEventBus.ts";

/** Composition root: concrete transport stays here; producers receive only domain ports. */
export async function createEventBoundary() {
  const bus = new InMemoryEventBus();
  const eventFactory = new SequencedFleetEventFactory();
  const consumer = new FleetProjectionConsumer(bus);
  await consumer.start();
  return {
    bus,
    consumer,
    simulationEvents: new SimulationEventEmitter(bus, eventFactory),
    dispatchEvents: new DispatchEventEmitter(bus, eventFactory),
    async close() {
      await consumer.stop();
      await bus.flush();
    },
  };
}
