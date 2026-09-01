const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

function stableVersion(value, label) {
  const normalized = value?.replace(/^v/, "");
  if (!normalized || !STABLE_VERSION.test(normalized)) {
    throw new Error(`${label} must use the stable MAJOR.MINOR.PATCH format.`);
  }
  return normalized;
}

export function resolvePublishedMixedPairing({
  pairing,
  releaseVersion,
  previousVersion = "0.5.0"
}) {
  const release = stableVersion(releaseVersion, "Release version");
  const previous = stableVersion(previousVersion, "Previous version");

  if (pairing === "python-current") {
    return {
      pythonVersion: release,
      javascriptVersion: previous,
      backendFixture: "distributed_backend.py",
      frontendFixture: "distributed-home.tsx",
      mode: "distributed"
    };
  }
  if (pairing === "javascript-current") {
    return {
      pythonVersion: previous,
      javascriptVersion: release,
      backendFixture: "mixed-legacy-backend.py",
      frontendFixture: "mixed-home.tsx",
      expectedCapabilities: "deferred-resources,live-resources",
      mode: "legacy"
    };
  }
  throw new Error("FLUXFAST_PAIRING must be either python-current or javascript-current.");
}
