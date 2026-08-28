import { useCallback, useEffect, useRef, useState } from "react";
import { parseRouteRemoval, parseRouteUpdate, parseVehicleMapRecord, type VehicleMapRecord } from "../api/contracts.ts";
import { createFleetEventSource, fetchFleetSnapshot, fetchVehicleDetail, type FleetEventSourceFactory } from "../api/fleetApi.ts";

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
  fetchDetail?: typeof fetchVehicleDetail;
  createEventSource?: FleetEventSourceFactory;
  maxSnapshotAttempts?: number;
  retryDelayMs?: number;
};

export function useFleetFeed(dependencies: Dependencies = {}): FleetFeed {
  const fetchSnapshot = dependencies.fetchSnapshot ?? fetchFleetSnapshot;
  const createEventSource = dependencies.createEventSource ?? createFleetEventSource;
  const fetchDetail = dependencies.fetchDetail ?? fetchVehicleDetail;
  const fetchSnapshotRef = useRef(fetchSnapshot);
  const createEventSourceRef = useRef(createEventSource);
  const fetchDetailRef = useRef(fetchDetail);
  fetchSnapshotRef.current = fetchSnapshot;
  createEventSourceRef.current = createEventSource;
  fetchDetailRef.current = fetchDetail;
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
    const routeRequests = new Set<string>();

    const publishRecords = () => {
      animationFrame = undefined;
      if (!disposed) setVehicles([...recordsRef.current.values()]);
    };
    const schedulePublish = () => {
      if (animationFrame === undefined) animationFrame = requestAnimationFrame(publishRecords);
    };
    const hydrateRoute = async (vehicleId: string, routeId: string): Promise<void> => {
      if (routeRequests.has(routeId)) return;
      routeRequests.add(routeId);
      try {
        const detail = await fetchDetailRef.current(vehicleId, abortController.signal);
        if (disposed || detail.activeRoute?.routeId !== routeId || !detail.activeRoute.geometry) return;
        const current = recordsRef.current.get(vehicleId);
        if (!current || current.activeRoute?.routeId !== routeId) return;
        recordsRef.current.set(vehicleId, { ...current, activeRoute: detail.activeRoute });
        schedulePublish();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError"))
          console.warn(`Active route geometry is temporarily unavailable for ${vehicleId}`);
      } finally { routeRequests.delete(routeId); }
    };
    const installSnapshot = (records: readonly VehicleMapRecord[]) => {
      recordsRef.current = new Map(records.map((record) => [record.vehicleId, record]));
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
      setVehicles([...recordsRef.current.values()]);
      records.forEach((record) => {
        if (record.status === "EN_ROUTE" && record.activeRoute) void hydrateRoute(record.vehicleId, record.activeRoute.routeId);
      });
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
            const activeRoute = recordsRef.current.get(record.vehicleId)?.activeRoute;
            recordsRef.current.set(record.vehicleId, record.status === "EN_ROUTE" && activeRoute ? { ...record, activeRoute } : record);
            schedulePublish();
          } catch {
            console.warn("Ignored malformed vehicle update from fleet stream");
          }
        });
        source.addEventListener("route.updated", (event) => {
          if (disposed || ownGeneration !== streamGeneration) return;
          try {
            const route = parseRouteUpdate(JSON.parse((event as MessageEvent).data) as unknown);
            const current = recordsRef.current.get(route.vehicleId);
            if (current) {
              const { vehicleId: _vehicleId, ...activeRoute } = route;
              recordsRef.current.set(route.vehicleId, { ...current, activeRoute });
              schedulePublish();
              void hydrateRoute(route.vehicleId, route.routeId);
            }
          } catch { console.warn("Ignored malformed route update from fleet stream"); }
        });
        source.addEventListener("route.removed", (event) => {
          if (disposed || ownGeneration !== streamGeneration) return;
          try {
            const removal = parseRouteRemoval(JSON.parse((event as MessageEvent).data) as unknown);
            const current = recordsRef.current.get(removal.vehicleId);
            if (current?.activeRoute?.routeId === removal.routeId) {
              const { activeRoute: _activeRoute, ...withoutRoute } = current;
              recordsRef.current.set(removal.vehicleId, withoutRoute);
              schedulePublish();
            }
          } catch { console.warn("Ignored malformed route removal from fleet stream"); }
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
