import type { FleetConnectionState } from "../hooks/useFleetFeed.ts";

const labels: Record<FleetConnectionState, string> = {
  LOADING_SNAPSHOT: "Starting", CONNECTING_STREAM: "Starting", LIVE: "Live", RETRYING: "Reconnecting", RESETTING: "Resetting", ERROR: "Error",
};

export function FleetConnection({ state, count, errorMessage, onRetry }: {
  readonly state: FleetConnectionState; readonly count: number; readonly errorMessage?: string; readonly onRetry: () => void;
}) {
  return <>
    <div className={`connection connection--${state.toLowerCase()}`} aria-live="polite">
      <span className="connection-dot" /><strong>{labels[state]}</strong><span aria-label={`${count} vehicles`}>{count} {count === 1 ? "vehicle" : "vehicles"}</span>
    </div>
    {state === "ERROR" && <div className="backend-error" role="alert"><span><strong>Fleet data unavailable.</strong> {errorMessage}</span>
      <button type="button" onClick={onRetry}>Retry</button></div>}
  </>;
}
