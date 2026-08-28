// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VehicleFilters } from "../components/VehicleFilters.tsx";

afterEach(cleanup);

describe("VehicleFilters", () => {
  it("renders current selections, counts, and reports changes", () => {
    const onStatusChange = vi.fn();
    const onLowBatteryChange = vi.fn();
    render(<VehicleFilters selectedStatuses={new Set(["FREE", "EN_ROUTE"])} lowBatteryOnly={false}
      visibleCount={7} totalCount={100} onStatusChange={onStatusChange} onLowBatteryChange={onLowBatteryChange} />);

    expect(screen.getByLabelText("Free")).toBeChecked();
    expect(screen.getByLabelText("With customer")).not.toBeChecked();
    expect(screen.getByLabelText("En route")).toBeChecked();
    expect(screen.getByText("Showing 7 of 100")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("With customer"));
    fireEvent.click(screen.getByLabelText("Below 20%"));
    expect(onStatusChange).toHaveBeenCalledWith("WITH_CUSTOMER", true);
    expect(onLowBatteryChange).toHaveBeenCalledWith(true);
  });
});
