import { expect, test } from "@playwright/test";

test("uses generated types through dynamic prefetch, navigation, history, and reload", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  const dynamicVisits: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("request", request => {
    if (
      request.headers()["x-fluxfast"] === "1" &&
      new URL(request.url()).pathname === "/hotels/101/rooms"
    ) {
      dynamicVisits.push(request.url());
    }
  });

  await page.goto("/");
  await expect(page.getByTestId("home-page")).toHaveAttribute("data-hydrated", "true");
  const typedRoute = page.getByRole("link", { name: "View Hotel 101 rooms" });
  await typedRoute.hover();
  await expect.poll(() => dynamicVisits.length).toBe(1);

  await typedRoute.click();
  await expect(page).toHaveURL(/\/hotels\/101\/rooms$/);
  await expect(page.getByRole("heading", { name: "Hotel 101 rooms" })).toBeVisible();
  await expect(page.getByTestId("typed-hotel-id")).toHaveText("Hotel ID 101");
  await expect(page.getByRole("list", { name: "Typed hotel room list" })).toContainText(
    "Garden Suite"
  );

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Control Center" })).toBeVisible();

  await page.goto("/hotels/101/rooms");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Hotel 101 rooms" })).toBeVisible();
  await expect(page.getByTestId("typed-hotel-id")).toHaveText("Hotel ID 101");
  expect(browserErrors).toEqual([]);
});

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
  await expect(page.getByTestId("home-page")).toHaveAttribute("data-hydrated", "true");

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

test("reuses a general type and validates a nested form before the server", async ({
  page,
}) => {
  const registrationRequests: string[] = [];
  page.on("request", request => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/registrations"
    ) {
      registrationRequests.push(request.url());
    }
  });

  await page.goto("/rooms");
  await expect(page.getByRole("article", { name: "Featured user" })).toContainText(
    "Ada Lovelace",
  );

  const registration = page.getByRole("form", { name: "Registration" });
  await registration.getByRole("button", { name: "Register" }).click();
  await expect(registration.getByRole("alert")).toContainText([
    "at least 2 characters",
    "at least 5 characters",
    "at least 2 characters",
    "at least 3 characters",
  ]);
  expect(registrationRequests).toEqual([]);

  await registration.getByLabel("Registration name").fill("Ada Lovelace");
  await registration.getByLabel("Registration email").fill("taken@example.com");
  await registration.getByLabel("Registration city").fill("Kuala Lumpur");
  await registration.getByLabel("Registration postcode").fill("50000");
  await registration.getByRole("button", { name: "Register" }).click();
  await expect(registration.getByRole("alert")).toContainText(
    "Email is already registered",
  );
  expect(registrationRequests).toHaveLength(1);

  await registration.getByLabel("Registration email").fill("ada@example.com");
  await registration.getByRole("button", { name: "Register" }).click();
  await expect(registration.getByRole("status")).toHaveText(
    "Registration accepted",
  );
  expect(registrationRequests).toHaveLength(2);
});

test("renders not-found after a mutation redirects to an unknown page", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  await page.goto("/rooms");

  const [notFoundResponse] = await Promise.all([
    page.waitForResponse(response =>
      response.request().resourceType() === "document" &&
      new URL(response.url()).pathname === "/route-that-does-not-exist"
    ),
    page.getByRole("button", { name: "Missing redirect" }).click(),
  ]);

  expect(notFoundResponse.status()).toBe(404);
  await expect(page).toHaveURL(/\/route-that-does-not-exist$/);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  expect(pageErrors).toEqual([]);
});
