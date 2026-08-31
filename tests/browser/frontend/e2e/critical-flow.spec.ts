import { expect, test } from "@playwright/test";

test("navigates, validates, mutates, and redirects through one browser origin", async ({
  page,
  baseURL,
}) => {
  const protocolRequests: Array<{ method: string; url: string }> = [];
  page.on("request", request => {
    if (request.headers()["x-fluxfast"] === "1") {
      protocolRequests.push({ method: request.method(), url: request.url() });
    }
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Control Center" })).toBeVisible();
  await expect(page.getByTestId("application-name")).toHaveText(
    "FluxFast Browser Fixture"
  );

  await page.getByRole("link", { name: "Manage rooms" }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Room list" })).toContainText(
    "Garden Suite"
  );

  await page.getByLabel("Room name").fill("A");
  await page.getByRole("button", { name: "Add room" }).click();
  await expect(page.locator("form").getByRole("alert")).toContainText(
    "at least 2 characters"
  );

  await page.getByLabel("Room name").fill("Sky Suite");
  await page.getByRole("button", { name: "Add room" }).click();
  await expect(page.getByRole("status")).toHaveText("Room added");
  await expect(page.getByRole("list", { name: "Room list" })).toContainText(
    "Sky Suite"
  );

  await page.getByRole("button", { name: "Finish" }).click();
  await expect(page).toHaveURL(baseURL! + "/");
  await expect(page.getByRole("heading", { name: "Control Center" })).toBeVisible();

  expect(protocolRequests.map(request => request.method)).toEqual([
    "GET",
    "POST",
    "POST",
    "POST",
    "GET",
  ]);
  for (const request of protocolRequests) {
    expect(new URL(request.url).origin).toBe(new URL(baseURL!).origin);
  }
});

test("renders not-found after a mutation redirects to an unknown page", async ({
  page,
}) => {
  await page.goto("/rooms");

  await page.getByRole("button", { name: "Missing redirect" }).click();

  await expect(page).toHaveURL(/\/route-that-does-not-exist$/);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
});
