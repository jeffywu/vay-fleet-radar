import { useCallback, useEffect, useRef, useState } from "react";
import { parseVehicleMapRecord, type VehicleMapRecord } from "../api/contracts.ts";
import { createFleetEventSource, fetchFleetSnapshot, type FleetEventSourceFactory } from "../api/fleetApi.ts";

export type FleetConnectionState = "LOADING_SNAPSHOT" | "CONNECTING_STREAM" | "LIVE" | "RETRYING" | "RESETTING" | "ERROR";

export type FleetFeed = {
  vehicles: readonly VehicleMapRecord[];
  staleAfterSeconds: number;
  connectionState: FleetConnectionState;
  errorMessage?: string;
  retry: () => void;
};

type Dependencies = {
  fetchSnapshot?: typeof fetchFleetSnapshot;
  createEventSource?: FleetEventSourceFactory;
  maxSnapshotAttempts?: number;
  retryDelayMs?: number;
};

export function useFleetFeed(dependencies: Dependencies = {}): FleetFeed {
  const fetchSnapshot = dependencies.fetchSnapshot ?? fetchFleetSnapshot;
  const createEventSource = dependencies.createEventSource ?? createFleetEventSource;
  const fetchSnapshotRef = useRef(fetchSnapshot);
  const createEventSourceRef = useRef(createEventSource);
  fetchSnapshotRef.current = fetchSnapshot;
  createEventSourceRef.current = createEventSource;
  const maxAttempts = dependencies.maxSnapshotAttempts ?? 3;
  const retryDelay = dependencies.retryDelayMs ?? 400;
  const recordsRef = useRef(new Map<string, VehicleMapRecord>());
  const [vehicles, setVehicles] = useState<readonly VehicleMapRecord[]>([]);
  const [staleAfterSeconds, setStaleAfterSeconds] = useState(60);
  const [connectionState, setConnectionState] = useState<FleetConnectionState>("LOADING_SNAPSHOT");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const retry = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    let disposed = false;
    let source: ReturnType<FleetEventSourceFactory> | undefined;
    let streamGeneration = 0;
    let animationFrame: number | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const abortController = new AbortController();

    const publishRecords = () => {
      animationFrame = undefined;
      if (!disposed) setVehicles([...recordsRef.current.values()]);
    };
    const schedulePublish = () => {
      if (animationFrame === undefined) animationFrame = requestAnimationFrame(publishRecords);
    };
    const installSnapshot = (records: readonly VehicleMapRecord[]) => {
      recordsRef.current = new Map(records.map((record) => [record.vehicleId, record]));
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
      setVehicles([...recordsRef.current.values()]);
    };

    const loadSnapshot = async (resetting: boolean, attempt = 1): Promise<void> => {
      if (disposed) return;
      setConnectionState(resetting ? "RESETTING" : attempt === 1 ? "LOADING_SNAPSHOT" : "RETRYING");
      setErrorMessage(undefined);
      try {
        const snapshot = await fetchSnapshotRef.current(abortController.signal);
        if (disposed) return;
        installSnapshot(snapshot.data);
        setStaleAfterSeconds(snapshot.meta.staleAfterSeconds);
        setConnectionState("CONNECTING_STREAM");
        const ownGeneration = ++streamGeneration;
        source = createEventSourceRef.current(snapshot.meta.streamCursor);
        source.addEventListener("open", () => {
          if (!disposed && ownGeneration === streamGeneration) setConnectionState("LIVE");
        });
        source.addEventListener("error", () => {
          if (!disposed && ownGeneration === streamGeneration) setConnectionState("RETRYING");
        });
        source.addEventListener("vehicle.updated", (event) => {
          if (disposed || ownGeneration !== streamGeneration) return;
          try {
            const record = parseVehicleMapRecord(JSON.parse((event as MessageEvent).data) as unknown);
            recordsRef.current.set(record.vehicleId, record);
            schedulePublish();
          } catch {
            console.warn("Ignored malformed vehicle update from fleet stream");
          }
        });
        source.addEventListener("stream.reset-required", () => {
          if (disposed || ownGeneration !== streamGeneration) return;
          ++streamGeneration;
          source?.close();
          source = undefined;
          void loadSnapshot(true);
        });
      } catch (error) {
        if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
        if (attempt < maxAttempts) {
          setConnectionState("RETRYING");
          retryTimer = setTimeout(() => void loadSnapshot(resetting, attempt + 1), retryDelay * attempt);
          return;
        }
        setConnectionState("ERROR");
        setErrorMessage(error instanceof Error ? error.message : "The fleet feed could not be started");
      }
    };

    const staleTimer = setInterval(schedulePublish, 1_000);
    void loadSnapshot(false);
    return () => {
      disposed = true;
      ++streamGeneration;
      abortController.abort();
      source?.close();
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      clearInterval(staleTimer);
    };
  }, [generation, maxAttempts, retryDelay]);

  return { vehicles, staleAfterSeconds, connectionState, ...(errorMessage ? { errorMessage } : {}), retry };
}
