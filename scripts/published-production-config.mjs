const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

export function resolvePublishedProductionConfig({
  version,
  pythonSpec,
  coreSpec,
  nextSpec,
} = {}) {
  if (version === undefined || version === "") return undefined;

  const normalizedVersion = version.replace(/^v/, "");
  if (!STABLE_VERSION.test(normalizedVersion)) {
    throw new Error(
      `FLUXFAST_PUBLISHED_VERSION must be a stable MAJOR.MINOR.PATCH version; received ${version}.`
    );
  }

  return {
    version: normalizedVersion,
    pythonSpec: pythonSpec ?? `fluxfast==${normalizedVersion}`,
    coreSpec: coreSpec ?? `@fluxfast/core@${normalizedVersion}`,
    nextSpec: nextSpec ?? `@fluxfast/next@${normalizedVersion}`,
    retryPython: pythonSpec === undefined,
    retryJavaScript: coreSpec === undefined || nextSpec === undefined,
  };
}
