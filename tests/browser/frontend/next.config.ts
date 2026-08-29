import type { NextConfig } from "next";
import { withFluxFast } from "@fluxfast/next/next-config";

const config: NextConfig = withFluxFast({
  reactStrictMode: true,
});

export default config;
