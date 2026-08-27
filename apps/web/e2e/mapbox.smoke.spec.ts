import { expect, test } from "@playwright/test";

test("renders the bounded Las Vegas world", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Fleet Radar" })).toBeVisible();
  await expect(page.getByText("200", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("9", { exact: true })).toBeVisible();
  await expect(page.getByTestId("map-canvas")).toHaveAttribute("data-map-ready", "true");
  await expect(page.locator(".mapboxgl-canvas")).toBeVisible();

  // This default-seed destination is stable at the smoke test's fixed viewport.
  await page.mouse.click(844, 134);
  await expect(page.locator(".selection code")).toHaveText(/^dst-lv-\d{4}$/);
});
