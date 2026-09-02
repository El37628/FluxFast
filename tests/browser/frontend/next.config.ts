import type { NextConfig } from "next";
import { withFluxFast } from "@fluxfast/next/next-config";

const standalone = process.env.FLUXFAST_STANDALONE === "1";

const config: NextConfig = withFluxFast({
  ...(standalone ? { output: "standalone" as const } : {}),
  reactStrictMode: true,
});

export default config;
