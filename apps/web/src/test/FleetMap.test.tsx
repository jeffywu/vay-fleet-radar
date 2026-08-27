// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { mapConstructor } = vi.hoisted(() => ({ mapConstructor: vi.fn() }));
vi.mock("mapbox-gl", () => ({
  default: {
    Map: mapConstructor,
    NavigationControl: vi.fn(),
    accessToken: "",
  },
}));

import { FleetMap } from "../components/FleetMap.tsx";

describe("FleetMap", () => {
  it("shows setup guidance and does not initialize Mapbox without a token", () => {
    const { rerender } = render(<FleetMap onDestinationSelect={vi.fn()} onWorldLoad={vi.fn()} />);
    expect(screen.getByText("Mapbox token required")).toBeInTheDocument();
    expect(mapConstructor).not.toHaveBeenCalled();
    rerender(<FleetMap onDestinationSelect={vi.fn()} onWorldLoad={vi.fn()} />);
    expect(mapConstructor).not.toHaveBeenCalled();
  });
});
