import { createHarness } from "./harnesses/index.mjs";

export default async function setup(config) {
  const harness = createHarness(undefined, config.metadata.conformance);
  try {
    if (process.env.FLUXFAST_E2E_PRODUCTION === "1" && process.env.FLUXFAST_CONFORMANCE_SKIP_BUILD !== "1") {
      await harness.build?.();
    }
    await harness.start();
  } catch (error) { await harness.stop(); throw error; }
  return async () => {
    await harness.stop();
    console.log(`✓ ${harness.name} conformance host shut down; public and private fixture ports released`);
  };
}
