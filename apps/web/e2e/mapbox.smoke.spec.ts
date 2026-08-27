import { expect, test } from "@playwright/test";

test("renders the live Las Vegas fleet", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Fleet Radar" })).toBeVisible();
  await expect(page.getByText("Live", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel("100 vehicles")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-map-ready", "true", { timeout: 20_000 });
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-vehicle-count", "100");
  await expect(page.locator(".mapboxgl-canvas")).toBeVisible();
  await expect(page.getByLabel("Vehicle status legend")).toContainText("Free");
  await expect(page.getByLabel("Vehicle status legend")).toContainText("With customer");
  await expect(page.getByLabel("Vehicle status legend")).toContainText("En route");
});
