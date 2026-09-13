import { expect, test } from "@playwright/test";

test("renders backend resources before JavaScript, then hydrates and uses the header-gated origin", async ({
  browser,
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL!).origin;
  const requests: Array<{ origin: string; document: boolean; flux: boolean }> = [];
  const errors: string[] = [];
  const observe = (observed: typeof page) => {
    observed.on("pageerror", error => errors.push(error.message));
    observed.on("request", request => {
      const url = new URL(request.url());
      if (!["http:", "https:"].includes(url.protocol)) return;
      requests.push({
        origin: url.origin,
        document: request.resourceType() === "document",
        flux: request.headers()["x-fluxfast"] === "1",
      });
    });
  };
  const serverOnly = await browser.newContext({ javaScriptEnabled: false });
  try {
    const document = await serverOnly.newPage();
    observe(document);
    const response = await document.goto(baseURL!);
    expect(response!.status()).toBe(200);
    expect(response!.headers()["content-type"]).toContain("text/html");
    await expect(document.getByTestId("application-name")).toHaveText("FluxFast Browser Fixture");
    await expect(document.getByTestId("home-page")).toHaveAttribute("data-hydrated", "false");
    expect(requests.some(request => request.flux)).toBe(false);
  } finally {
    await serverOnly.close();
  }

  observe(page);
  const initial = await page.goto("/");
  expect(await initial!.text()).toContain('data-hydrated="false"');
  await expect(page.getByTestId("home-page")).toHaveAttribute("data-hydrated", "true");
  const documentCount = requests.filter(request => request.document).length;
  const transport = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/rooms" &&
    response.request().headers()["x-fluxfast"] === "1"
  );
  await page.getByRole("link", { name: "Manage rooms" }).click();
  const navigation = await transport;
  expect(navigation.status()).toBe(200);
  expect(navigation.request().method()).toBe("GET");
  expect(navigation.headers()["content-type"]).toContain("json");
  expect((await navigation.json()).page.component).toBe("rooms/index");
  await expect(page.getByRole("heading", { name: "Rooms" })).toBeVisible();
  expect(requests.filter(request => request.document)).toHaveLength(documentCount);

  // The same public path is HTML for documents, protocol JSON only with the gate.
  const ordinary = await page.request.get("/rooms");
  expect(ordinary.status()).toBe(200);
  expect(ordinary.headers()["content-type"]).toContain("text/html");
  const protocol = await page.request.get("/rooms", {
    headers: { "X-FluxFast": "1", "X-FluxFast-Protocol": "1" },
  });
  expect(protocol.status()).toBe(200);
  expect((await protocol.json()).page.component).toBe("rooms/index");
  expect(protocol.headers()["access-control-allow-origin"]).toBeUndefined();
  expect([...new Set(requests.map(request => request.origin))]).toEqual([origin]);
  expect(requests.filter(request => request.document).every(request => !request.flux)).toBe(true);
  expect(errors).toEqual([]);
});

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
  const browserErrors: string[] = [];
  const expectedValidationErrors: string[] = [];
  const registrationRequests: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  page.on("console", message => {
    if (message.type() !== "error") return;
    if (message.text().includes("status of 422")) {
      expectedValidationErrors.push(message.text());
      return;
    }
    browserErrors.push(message.text());
  });
  page.on("request", request => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/registrations"
    ) {
      registrationRequests.push(request.url());
    }
  });

  await page.goto("/rooms");
  await expect(page.getByTestId("rooms-page")).toHaveAttribute("data-hydrated", "true");
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
  await registration.getByLabel("Registration email").fill("ada@example.com");
  await registration.getByLabel("Registration city").fill("Kuala Lumpur");
  await registration.getByLabel("Registration postcode").fill("99999");
  await registration.getByRole("button", { name: "Register" }).click();
  await expect(page.getByTestId("registration-postcode-error")).toHaveText(
    "Value error, Postcode is not serviceable",
  );
  expect(registrationRequests).toHaveLength(1);

  await registration.getByLabel("Registration postcode").fill("50000");
  await registration.getByRole("button", { name: "Register" }).click();
  await expect(registration.getByRole("status")).toHaveText(
    "Registration accepted",
  );
  expect(registrationRequests).toHaveLength(2);
  expect(expectedValidationErrors).toHaveLength(1);
  expect(browserErrors).toEqual([]);
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
