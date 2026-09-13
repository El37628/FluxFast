import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { observePageBody, omittedKnownResources, outsideCheckout, ownedProcesses, positiveInteger, processIdentity, serverDiagnostics, snapshotInputs } from "./soak-observation.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function ports() {
  const servers = [net.createServer(), net.createServer()];
  try {
    await Promise.all(servers.map(server => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    })));
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => server.listening
      ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) : undefined));
  }
}

async function eventually(observe, expected, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let actual;
  do {
    actual = await observe();
    if (actual === expected) return;
    await delay(50);
  } while (Date.now() < deadline);
  assert.equal(actual, expected, label);
}

function option(name, fallback, maximum) {
  const index = process.argv.indexOf(name);
  return positiveInteger(index < 0 ? fallback : process.argv[index + 1], name, maximum);
}

export async function exerciseConsumer({ consumer, python, fluxfast, temporaryRoot,
  cycles = option("--cycles", 200, 10000), starts = option("--starts", 3, 100) }) {
  assert.equal(process.platform, "linux", "RSS/owned-process evidence currently requires Linux /proc");
  consumer = outsideCheckout(consumer, repository);
  const require = createRequire(path.join(consumer, "package.json"));
  const { chromium } = require("@playwright/test");
  for (const name of ["@fluxfast/core", "@fluxfast/next"]) {
    const directory = fs.realpathSync(path.join(consumer, "node_modules", ...name.split("/")));
    assert.ok(directory.startsWith(`${consumer}${path.sep}`), `${name} is not isolated`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, "package.json"))).version, "0.9.0");
  }
  const pythonVersions = spawnSync(python, ["-c", "import json, sys, sqlite3, fluxfast; "
    + "from importlib.metadata import distributions, version; from pathlib import Path; "
    + "assert version('fluxfast') == '0.9.0'; assert Path(fluxfast.__file__).is_relative_to(Path(sys.prefix)); "
    + "print(json.dumps({'python': sys.version.split()[0], 'sqlite': sqlite3.sqlite_version, "
    + "'packages': {d.metadata['Name']: d.version for d in distributions()}}))"],
  { cwd: consumer, env: { ...process.env, PYTHONPATH: "" }, encoding: "utf8" });
  assert.equal(pythonVersions.status, 0, pythonVersions.stderr);
  const report = {
    status: "running", startedAt: new Date().toISOString(), consumerShape: "operations-board-single-worker-memory",
    deploymentCount: 1, requested: { cyclesPerStart: cycles, starts }, versions: {
      node: process.version, ...JSON.parse(pythonVersions.stdout),
      next: require("next/package.json").version, react: require("react/package.json").version,
      playwright: require("@playwright/test/package.json").version,
    }, counts: { starts: 0, cycles: 0, navigations: 0, historyRestores: 0, successfulMutations: 0,
      nativeValidationBlocks: 0, expectedServerValidationRejections: 0, prefetchRequests: 0,
      resourceOnlyRequests: 0, knownVersionRequests: 0, omittedKnownResources: 0,
      authTransitions: 0, crossTenantChecks: 0 }, phases: [], browserExceptions: [],
    consoleMessages: [], unexpectedResponses: [], generatedInputChanges: [],
  };
  const reportPath = path.join(temporaryRoot, `soak-${Date.now()}.json`);
  const databasePath = reportPath.replace(/\.json$/, ".sqlite3");
  const before = snapshotInputs(consumer);
  const generated = Object.keys(before).filter(name => name.startsWith("src/.fluxfast/"));
  for (const name of ["schema.generated.json", "types.generated.ts", "validators.generated.ts",
    "routes.generated.ts", "mutations.generated.ts", "pages.generated.ts"]) {
    assert.ok(generated.includes(`src/.fluxfast/${name}`), `missing ${name}`);
  }
  report.generatedInputs = Object.fromEntries(generated.map(name => [name, before[name].content]));
  const [publicPort, privatePort] = await ports();
  const origin = `http://127.0.0.1:${publicPort}`;
  let profile = "Alice";
  let persistentTask;
  let browser;
  let failure;

  try {
    browser = await chromium.launch({ headless: true, args: ["--enable-precise-memory-info"] });
    for (let phaseIndex = 0; phaseIndex < starts; phaseIndex += 1) {
      const phase = { index: phaseIndex, startedAt: new Date().toISOString(), cycles: 0,
        streams: { alice: 0, bob: 0, carol: 0 }, staticCarolStreamOpens: 0,
        memory: [], browserHeap: [], shutdown: {}, logs: "" };
      report.phases.push(phase);
      const phaseStarted = Date.now();
      phase.runtimeLogPath = `${reportPath}.phase-${phaseIndex}.log`;
      const runtimeLog = fs.createWriteStream(phase.runtimeLogPath, { flags: "wx" });
      let runtimeLogError;
      runtimeLog.on("error", error => { runtimeLogError = error; });
      const logClosed = new Promise(resolve => runtimeLog.once("close", resolve));
      const diagnostics = serverDiagnostics();
      const child = spawn(fluxfast, ["start", "backend:app", "--frontend", consumer,
        "--host", "127.0.0.1", "--port", String(publicPort), "--backend-host", "127.0.0.1",
        "--backend-port", String(privatePort), "--startup-timeout", "90", "--shutdown-timeout", "10"],
      { cwd: consumer, detached: true, env: { ...process.env, PYTHONPATH: "", NEXT_TELEMETRY_DISABLED: "1",
        FLUXFAST_SOAK_DB: databasePath },
        stdio: ["ignore", "pipe", "pipe"] });
      let launchError;
      child.on("error", error => { launchError = error; });
      // close, not exit: all captured stdout/stderr must drain before the full
      // runtime log is finalized and diagnostic evidence is assessed.
      const exited = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
      const output = chunk => {
        phase.logs = `${phase.logs}${chunk}`.slice(-100000);
        diagnostics.write(chunk);
        if (!runtimeLogError) runtimeLog.write(chunk);
      };
      child.stdout.on("data", output);
      child.stderr.on("data", output);
      const rootIdentity = processIdentity(child.pid);
      assert.ok(rootIdentity, "supervisor process identity unavailable");
      const observed = new Map();
      const pendingResponses = new Set();
      const contexts = [];
      let inStaticWorkload = false;
      function sampleMemory(cycle) {
        const processes = ownedProcesses(rootIdentity);
        for (const process of processes) observed.set(`${process.pid}:${process.born}`, process);
        phase.memory.push({ cycle, elapsedMs: Date.now() - phaseStarted,
          totalRssKiB: processes.reduce((sum, process) => sum + process.rssKiB, 0), processes });
      }
      function attach(page, user) {
        page.on("pageerror", error => report.browserExceptions.push({ phase: phaseIndex, user, message: error.message }));
        page.on("console", message => {
          if (["warning", "error"].includes(message.type())) report.consoleMessages.push({
            phase: phaseIndex, user, type: message.type(), message: message.text(),
            path: message.location().url ? new URL(message.location().url).pathname : "",
          });
        });
        page.on("request", request => {
          const headers = request.headers();
          if (headers.accept?.includes("text/event-stream")) {
            phase.streams[user] += 1;
            if (user === "carol" && inStaticWorkload) phase.staticCarolStreamOpens += 1;
          }
          if (headers["x-fluxfast"] !== "1") return;
          assert.equal(new URL(request.url()).origin, origin, "protocol request crossed the public origin");
          if (headers["x-fluxfast-visit"]?.startsWith("prefetch_")) report.counts.prefetchRequests += 1;
          if (headers["x-fluxfast-only"]) report.counts.resourceOnlyRequests += 1;
          if (headers["x-fluxfast-known"]) report.counts.knownVersionRequests += 1;
        });
        page.on("response", response => {
          const request = response.request();
          const pathname = new URL(response.url()).pathname;
          if (response.status() >= 400) {
            if (response.status() === 422 && request.method() === "POST" && pathname === "/tasks") {
              // Every intentional rejection is also asserted at its scenario.
              report.counts.expectedServerValidationRejections += 1;
            } else report.unexpectedResponses.push({ phase: phaseIndex, user, path: pathname,
              status: response.status(), method: request.method() });
          }
          if (observePageBody(request.method(), request.headers(), response.headers(), response.status())) {
            const task = (async () => {
              try {
                const envelope = await response.json();
                report.counts.omittedKnownResources += omittedKnownResources(envelope, request.headers()["x-fluxfast-known"]);
              } catch (error) {
                report.browserExceptions.push({ phase: phaseIndex, user, path: pathname,
                  live: request.headers()["x-fluxfast-live"], message: `response observation: ${error.message}` });
              }
            })();
            pendingResponses.add(task);
            task.finally(() => pendingResponses.delete(task));
          }
        });
      }
      const text = (page, name) => page.getByTestId(name).textContent();
      const waitText = (page, name, expected) => eventually(() => text(page, name), String(expected), `${name} did not converge`);
      const nav = async (page, name, heading) => {
        await page.getByRole("navigation").getByRole("link", { name, exact: true }).click();
        await page.getByRole("heading", { name: heading, exact: true }).waitFor();
        report.counts.navigations += 1;
      };
      const submit = async (page, button, route) => {
        const response = page.waitForResponse(response => response.request().method() === "POST"
          && new URL(response.url()).pathname === route);
        await button.click();
        assert.equal((await response).status(), 200, `mutation ${route} failed`);
        report.counts.successfulMutations += 1;
      };
      const create = async (page, title) => {
        const form = page.getByRole("form", { name: "Create task", exact: true });
        await form.getByLabel("Task title", { exact: true }).fill(title);
        await form.getByLabel(/^Description/).fill("Coordinate the stable release with the operations team");
        await form.getByLabel("Assignment note", { exact: true }).fill("Release rehearsal");
        await submit(page, form.getByRole("button", { name: "Create task", exact: true }), "/tasks");
        await page.getByRole("table").getByRole("link", { name: title, exact: true }).waitFor();
        return Number(await page.getByRole("table").getByRole("row").filter({ hasText: title }).getAttribute("data-task-id"));
      };
      const detail = async (page, title) => {
        await page.getByRole("table").getByRole("link", { name: title, exact: true }).click();
        await page.getByRole("heading", { name: "Task details", exact: true }).waitFor();
        await waitText(page, "task-title", title);
        report.counts.navigations += 1;
      };
      try {
        const deadline = Date.now() + 120000;
        let ready = false;
        while (Date.now() < deadline) {
          if (launchError) throw launchError;
          assert.equal(child.exitCode, null, `supervisor exited before readiness\n${phase.logs}`);
          try {
            const response = await fetch(`${origin}/login`, { signal: AbortSignal.timeout(1000) });
            ready = response.ok && (await response.text()).includes("Operations Board sign in");
            if (ready) break;
          } catch { /* The managed servers are still starting. */ }
          await delay(200);
        }
        assert.ok(ready, `soak application did not become ready\n${phase.logs}`);
        phase.startupMs = Date.now() - phaseStarted;
        report.counts.starts += 1;
        for (const endpoint of ["healthz", "readyz"]) {
          const response = await fetch(`${origin}/_fluxfast/${endpoint}`);
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("cache-control"), "no-store");
        }
        report.runtime = await (await fetch(`${origin}/_soak/environment`, { headers: { "X-FluxFast": "1" } })).json();
        if (phaseIndex === 0) {
          // Reproduce the early-input boundary independently of the workload:
          // hold the app's JavaScript, type into SSR HTML, then hydrate. Only
          // the submitted account name is recorded, never password or cookie.
          const context = await browser.newContext();
          contexts.push(context);
          const page = await context.newPage();
          let release;
          const scriptsReady = new Promise(resolve => { release = resolve; });
          await context.route(/\/_next\/static\/.*\.js(?:\?.*)?$/, async route => {
            await scriptsReady;
            await route.continue();
          });
          try {
            await page.goto(`${origin}/login`, { waitUntil: "commit" });
            await page.getByLabel("Account", { exact: true }).waitFor();
            assert.equal(await page.getByRole("form", { name: "Sign in", exact: true }).getAttribute("data-hydrated"), "false");
            await page.getByLabel("Account", { exact: true }).fill("bob");
            phase.hydrationProbe = { beforeHydration: await page.getByLabel("Account", { exact: true }).inputValue() };
            release();
            await page.locator('form[aria-label="Sign in"][data-hydrated=true]').waitFor();
            await page.getByLabel("Password", { exact: true }).fill("soak-password");
            const submitted = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/session");
            await page.getByRole("button", { name: "Sign in", exact: true }).click();
            phase.hydrationProbe.submittedAccount = (await submitted).postDataJSON().user_id;
            await page.getByRole("heading", { name: "Operations dashboard", exact: true }).waitFor();
            const canonical = await (await page.request.get(origin, { headers: { "X-FluxFast": "1" } })).json();
            phase.hydrationProbe.canonicalAccount = canonical.resources.viewer.value.user_id;
            phase.hydrationProbe.displayedName = await text(page, "viewer");
            assert.equal(phase.hydrationProbe.canonicalAccount, phase.hydrationProbe.submittedAccount);
            await page.getByRole("button", { name: "Sign out", exact: true }).click();
            await page.getByRole("heading", { name: "Operations Board sign in", exact: true }).waitFor();
          } finally {
            release();
            await context.close();
          }
        }
        const pages = {};
        for (const user of ["alice", "bob", "carol"]) {
          const context = await browser.newContext();
          contexts.push(context);
          const page = await context.newPage();
          pages[user] = page;
          attach(page, user);
          await page.goto(`${origin}/login`);
          await page.locator('form[aria-label="Sign in"][data-hydrated=true]').waitFor();
          await page.getByLabel("Account", { exact: true }).fill(user);
          await page.getByLabel("Password", { exact: true }).fill("soak-password");
          await page.getByRole("button", { name: "Sign in", exact: true }).click();
          await page.getByRole("heading", { name: "Operations dashboard", exact: true }).waitFor();
          const identityResponse = await page.request.get(`${origin}/`, { headers: { "X-FluxFast": "1" } });
          const identityEnvelope = await identityResponse.json();
          phase.identities ??= [];
          phase.identities.push({ requested: user, backend: identityEnvelope.resources?.viewer?.value,
            displayed: await text(page, "viewer") });
          assert.equal(identityEnvelope.resources?.viewer?.value.user_id, user, "session identity mismatch");
          await waitText(page, "tenant", user === "carol" ? "beta" : "alpha");
          await waitText(page, "live-status", "connected");
          await page.getByTestId("task-total").waitFor();
          report.counts.authTransitions += 1;
        }
        const { alice, bob, carol } = pages;
        await waitText(alice, "viewer", profile);
        await waitText(bob, "viewer", "Bob");
        await nav(alice, "Tasks", "Task board");
        await nav(bob, "Tasks", "Task board");
        await nav(carol, "Reports", "Release reports");
        const baseline = Number(await text(alice, "task-total"));
        const betaBaseline = Number(await text(carol, "task-total"));
        assert.equal(betaBaseline, 30);
        await waitText(bob, "task-total", baseline);
        if (phaseIndex > 0) {
          const missing = await alice.request.get(`${origin}/tasks/1`, { headers: { "X-FluxFast": "1" } });
          assert.equal(missing.status(), 404, "restart restored a deleted seeded task");
          assert.ok(persistentTask, "restart persistence sentinel missing");
          await detail(alice, persistentTask.title);
          await waitText(alice, "task-description", persistentTask.description);
          await submit(alice, alice.getByRole("button", { name: "Delete task", exact: true }), `/tasks/${persistentTask.id}/delete`);
          await alice.getByRole("heading", { name: "Task board", exact: true }).waitFor();
          await waitText(alice, "task-total", baseline - 1);
          await waitText(bob, "task-total", baseline - 1);
          persistentTask = undefined;
        }
        // Native validation blocks before network I/O; server-only refinement
        // and uniqueness failures must remain canonical nested form errors.
        const editor = alice.getByRole("form", { name: "Create task", exact: true });
        let submissions = 0;
        const countSubmissions = request => {
          if (request.method() === "POST" && new URL(request.url()).pathname === "/tasks") submissions += 1;
        };
        alice.on("request", countSubmissions);
        await editor.getByLabel("Task title", { exact: true }).fill("x");
        await editor.getByRole("button", { name: "Create task", exact: true }).click();
        await editor.locator("[data-error-path=title]").waitFor();
        assert.equal(submissions, 0, "native invalid input reached the server");
        report.counts.nativeValidationBlocks += 1;
        alice.off("request", countSubmissions);
        for (const [title, note, location] of [[`Rejected ${phaseIndex}`, "restricted", "assignment.note"],
          ["Alpha task 3", "Release rehearsal", "title"]]) {
          await editor.getByLabel("Task title", { exact: true }).fill(title);
          await editor.getByLabel("Assignment note", { exact: true }).fill(note);
          const rejected = alice.waitForResponse(response => response.request().method() === "POST"
            && new URL(response.url()).pathname === "/tasks");
          await editor.getByRole("button", { name: "Create task", exact: true }).click();
          const response = await rejected;
          assert.equal(response.status(), 422);
          const envelope = await response.json();
          assert.equal(envelope.protocol, "fluxfast/1");
          assert.equal(envelope.error?.type, "ValidationError");
          assert.ok(envelope.error.details[location]);
          await editor.locator(`[data-error-path="${location}"]`).waitFor();
        }
        await editor.getByLabel("Assignment note", { exact: true }).fill("Release rehearsal");
        const total = Number(await text(alice, "task-total"));
        inStaticWorkload = true;
        sampleMemory(0);
        for (let cycle = 0; cycle < cycles; cycle += 1) {
          const title = `Release ${phaseIndex}-${cycle}-${Date.now()}`;
          const id = await create(alice, title);
          await bob.getByRole("link", { name: title, exact: true }).waitFor();
          await waitText(bob, "task-total", total + 1);
          await waitText(alice, "task-total", total + 1);
          await waitText(carol, "task-total", betaBaseline);
          const foreign = await carol.request.get(`${origin}/tasks/${id}`, { headers: { "X-FluxFast": "1" } });
          assert.equal(foreign.status(), 404);
          report.counts.crossTenantChecks += 1;
          await detail(alice, title);
          const edit = alice.getByRole("form", { name: "Edit task", exact: true });
          const description = `Reviewed by operations: phase ${phaseIndex}, cycle ${cycle}`;
          await edit.getByLabel(/^Description/).fill(description);
          await edit.getByLabel(/^Priority/).selectOption("urgent");
          await submit(alice, edit.getByRole("button", { name: "Save task", exact: true }), `/tasks/${id}/update`);
          await waitText(alice, "task-description", description);
          const discussion = alice.getByRole("form", { name: "Comment", exact: true });
          await discussion.getByLabel("Comment", { exact: true }).fill(`Release checklist approved ${cycle}`);
          await submit(alice, discussion.getByRole("button", { name: "Add comment", exact: true }), `/tasks/${id}/comments`);
          await alice.getByTestId("task-comment").filter({ hasText: `Release checklist approved ${cycle}` }).waitFor();
          for (const [button, status] of [["Start task", "in-progress"], ["Complete task", "done"]]) {
            await submit(alice, alice.getByRole("button", { name: button, exact: true }), `/tasks/${id}/status`);
            await waitText(alice, "task-status", status);
            await eventually(() => bob.locator(`tr[data-task-id="${id}"] [data-task-status]`).textContent(), status,
              "second same-tenant client failed to converge");
          }
          assert.equal(await text(alice, "task-revision"), "4");
          await submit(alice, alice.getByRole("button", { name: "Delete task", exact: true }), `/tasks/${id}/delete`);
          await alice.getByRole("heading", { name: "Task board", exact: true }).waitFor();
          await waitText(alice, "task-total", total);
          await waitText(bob, "task-total", total);
          await eventually(() => bob.locator(`tr[data-task-id="${id}"]`).count(), 0, "deleted task remained in another client's store");
          await waitText(carol, "task-total", betaBaseline);
          await nav(alice, "Search", "Search tasks");
          await alice.getByLabel("Search", { exact: true }).fill("Alpha task 7");
          assert.equal(await alice.getByRole("table").locator("tbody tr").count(), 1);
          await alice.goBack();
          await alice.getByRole("heading", { name: "Task board", exact: true }).waitFor();
          await alice.goForward();
          await alice.getByRole("heading", { name: "Search tasks", exact: true }).waitFor();
          report.counts.historyRestores += 2;
          await nav(alice, "Tasks", "Task board");
          report.counts.cycles += 1;
          phase.cycles += 1;
          if ((cycle + 1) % 10 === 0 || cycle + 1 === cycles) {
            sampleMemory(cycle + 1);
            phase.browserHeap.push({ cycle: cycle + 1, usedJSHeapSize: await alice.evaluate(() => performance.memory?.usedJSHeapSize ?? null) });
            console.log(`soak phase ${phaseIndex + 1}/${starts}: ${cycle + 1}/${cycles} business cycles`);
          }
        }
        // A static different-tenant page must survive actual age rotations,
        // not merely stream opens caused by navigations in the mutation client.
        await eventually(() => phase.staticCarolStreamOpens > 0, true, "no static-page SSE rotation observed", 20000);
        await waitText(carol, "live-status", "connected");
        inStaticWorkload = false;
        await nav(bob, "Team", "Workspace team");
        await nav(alice, "Settings", "Account settings");
        profile = `Alice release ${phaseIndex + 1}`;
        const profileForm = alice.getByRole("form", { name: "Update profile", exact: true });
        await profileForm.getByLabel("Display name", { exact: true }).fill(profile);
        await submit(alice, profileForm.getByRole("button", { name: "Save profile", exact: true }), "/profile");
        await waitText(alice, "viewer", profile);
        await bob.getByTestId("member").filter({ hasText: profile }).waitFor();
        await waitText(bob, "viewer", "Bob");
        await nav(alice, "Reports", "Release reports");
        const hover = alice.waitForRequest(request => request.headers()["x-fluxfast-visit"]?.startsWith("prefetch_"));
        await alice.getByRole("navigation").getByRole("link", { name: "Dashboard", exact: true }).hover();
        await hover;
        await nav(alice, "Dashboard", "Operations dashboard");
        await nav(alice, "Tasks", "Task board");
        if (phaseIndex === 0) {
          await detail(alice, "Alpha task 1");
          await submit(alice, alice.getByRole("button", { name: "Delete task", exact: true }), "/tasks/1/delete");
          await alice.getByRole("heading", { name: "Task board", exact: true }).waitFor();
          await waitText(alice, "task-total", total - 1);
        }
        if (phaseIndex + 1 < starts) {
          const title = `Persistent release ${phaseIndex}-${Date.now()}`;
          const id = await create(alice, title);
          await detail(alice, title);
          const description = `Stored edit survives supervisor restart ${phaseIndex}`;
          const edit = alice.getByRole("form", { name: "Edit task", exact: true });
          await edit.getByLabel(/^Description/).fill(description);
          await submit(alice, edit.getByRole("button", { name: "Save task", exact: true }), `/tasks/${id}/update`);
          await waitText(alice, "task-description", description);
          persistentTask = { title, id, description };
        }
        const oldCookie = (await alice.context().cookies()).find(cookie => cookie.name === "fluxfast_soak_session");
        assert.ok(oldCookie?.httpOnly && oldCookie.sameSite === "Lax");
        await alice.getByRole("button", { name: "Sign out", exact: true }).click();
        await alice.getByRole("heading", { name: "Operations Board sign in", exact: true }).waitFor();
        await alice.locator('form[aria-label="Sign in"][data-hydrated=true]').waitFor();
        const revoked = await fetch(`${origin}/profile`, { method: "POST", headers: {
          "X-FluxFast": "1", "Content-Type": "application/json", Cookie: `fluxfast_soak_session=${oldCookie.value}`,
        }, body: JSON.stringify({ name: "Revoked identity" }) });
        assert.equal(revoked.status, 401);
        await alice.getByLabel("Account", { exact: true }).fill("carol");
        await alice.getByLabel("Password", { exact: true }).fill("soak-password");
        await alice.getByRole("button", { name: "Sign in", exact: true }).click();
        await alice.getByRole("heading", { name: "Operations dashboard", exact: true }).waitFor();
        await waitText(alice, "tenant", "beta");
        await waitText(alice, "task-total", betaBaseline);
        assert.equal(await alice.locator("tr[data-tenant=alpha]").count(), 0, "old tenant resources survived auth transition");
        report.counts.authTransitions += 2;
        report.counts.crossTenantChecks += 1;
        sampleMemory(cycles);
        await Promise.race([Promise.all([...pendingResponses]), delay(5000)]);
        assert.equal(pendingResponses.size, 0, "page-response observations did not settle within 5 seconds");
      } catch (error) {
        phase.failurePages = [];
        for (const context of contexts) {
          for (const page of context.pages()) {
            phase.failurePages.push({ path: new URL(page.url()).pathname,
              text: await page.locator("body").innerText().catch(() => "unavailable"),
              forms: await page.locator("form").evaluateAll(forms => forms.map(form => ({
                name: form.getAttribute("aria-label"), labels: [...form.querySelectorAll("label")].map(label => label.textContent),
              }))).catch(() => []) });
          }
        }
        throw error;
      } finally {
        const contextCleanup = await Promise.allSettled(contexts.map(context => context.close()));
        phase.contextCleanupErrors = contextCleanup.filter(result => result.status === "rejected")
          .map(result => String(result.reason));
        sampleMemory(phase.cycles);
        const shutdownStarted = Date.now();
        if (child.exitCode === null && child.signalCode === null && processIdentity(child.pid)?.born === rootIdentity.born)
          child.kill("SIGTERM");
        const outcome = await Promise.race([exited, delay(15000).then(() => undefined)]);
        phase.shutdown = { elapsedMs: Date.now() - shutdownStarted, outcome };
        const surviving = [...observed.values()].filter(identity => {
          const current = processIdentity(identity.pid);
          return current && current.born === identity.born && current.state !== "Z";
        });
        phase.shutdown.orphans = surviving.map(identity => identity.pid);
        if (!outcome || surviving.length) {
          // Cleanup only identities captured from this supervisor, never a
          // broad process name, workspace, or unrelated user's process group.
          for (const identity of surviving) {
            if (processIdentity(identity.pid)?.born === identity.born) process.kill(identity.pid, "SIGKILL");
          }
        }
        runtimeLog.end();
        await logClosed;
        phase.serverDiagnostics = diagnostics.finish();
        assert.equal(runtimeLogError, undefined, "failed to preserve full runtime log");
        assert.ok(outcome, `supervisor did not shut down gracefully\n${phase.logs}`);
        assert.equal(outcome.code, 0, `supervisor shutdown failed\n${phase.logs}`);
        assert.deepEqual(phase.shutdown.orphans, [], "owned child processes survived shutdown");
        phase.elapsedMs = Date.now() - phaseStarted;
      }
    }
    assert.deepEqual(report.browserExceptions, [], "unexpected browser exception");
    assert.deepEqual(report.unexpectedResponses, [], "unexpected HTTP failure");
    for (const phase of report.phases) {
      assert.deepEqual(phase.serverDiagnostics, { lines: [], truncated: false }, "unexpected server diagnostic or incomplete warning evidence");
      assert.deepEqual(phase.contextCleanupErrors, [], "browser context cleanup failed");
    }
    // Keep intentional 422 browser diagnostics visible rather than hiding all
    // console errors. All other warnings/errors remain a failed observation.
    report.expectedValidationDiagnostics = report.consoleMessages.filter(message => message.path === "/tasks"
      && /Failed to load resource.*422/.test(message.message));
    report.unexpectedConsoleMessages = report.consoleMessages.filter(message => !report.expectedValidationDiagnostics.includes(message));
    assert.deepEqual(report.unexpectedConsoleMessages, [], "unexpected browser warning/error");
    const after = snapshotInputs(consumer);
    report.generatedInputChanges = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name]));
    assert.deepEqual(report.generatedInputChanges, [], "production runtime rewrote source or generated inputs");
    assert.ok(report.counts.prefetchRequests > 0 && report.counts.resourceOnlyRequests > 0
      && report.counts.knownVersionRequests > 0 && report.counts.omittedKnownResources > 0,
    "missing observed prefetch/deferred/known-version evidence");
    report.status = "passed";
  } catch (error) {
    failure = error;
    report.status = "failed";
    report.failure = { name: error.name, message: error.message, stack: error.stack };
  } finally {
    await browser?.close();
    report.endedAt = new Date().toISOString();
    report.elapsedMs = Date.parse(report.endedAt) - Date.parse(report.startedAt);
    // A produced report is an observation, not a multi-day claim or an
    // automatic release-readiness verdict. Preserve failures as evidence too.
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Soak evidence: ${reportPath} (${report.status})`);
  }
  if (failure) throw failure;
  return { report, reportPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const consumer = path.resolve(process.argv[2] ?? ".");
  const temporaryRoot = path.dirname(consumer);
  const bin = path.join(temporaryRoot, "venv", "bin");
  await exerciseConsumer({ consumer, python: path.join(bin, "python"), fluxfast: path.join(bin, "fluxfast"), temporaryRoot });
}
