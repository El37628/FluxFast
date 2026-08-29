import { createFluxNextPage } from "@fluxfast/next/server";
import { fluxConfig } from "@/fluxfast.config";

export const dynamic = "force-dynamic";

export default createFluxNextPage(fluxConfig);
