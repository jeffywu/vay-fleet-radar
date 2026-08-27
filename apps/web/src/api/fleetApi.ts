import { parseFleetSnapshot, type FleetSnapshot } from "./contracts.ts";

export type FleetEventSource = {
  addEventListener(type: string, listener: (event: Event | MessageEvent) => void): void;
  close(): void;
};
export type FleetEventSourceFactory = (cursor: string) => FleetEventSource;

export async function fetchFleetSnapshot(signal: AbortSignal): Promise<FleetSnapshot> {
  let response: Response;
  try {
    response = await fetch("/api/vehicles", { signal, headers: { Accept: "application/json" } });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("The fleet backend is unavailable");
  }
  if (!response.ok) throw new Error("The fleet snapshot could not be loaded");
  let input: unknown;
  try { input = await response.json(); }
  catch { throw new Error("The fleet backend returned an invalid response"); }
  return parseFleetSnapshot(input);
}

export const createFleetEventSource: FleetEventSourceFactory = (cursor) =>
  new EventSource(`/api/events?after=${encodeURIComponent(cursor)}`);
