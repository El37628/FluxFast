"use client";

import { Link, usePage, useResource } from "@fluxfast/next";
import { routes } from "@/.fluxfast/routes.generated";
import { resourceKeys } from "@/.fluxfast/types.generated";

export default function ReportPage() {
  const page = usePage();
  const navigation = useResource(resourceKeys.navigation);
  const report = useResource(resourceKeys.reportDetail);

  return (
    <main>
      <h1>{report.title}</h1>
      <p data-testid="navigation-value">{navigation.label}</p>
      <p data-testid="report-id">{report.reportId}</p>
      <p data-testid="report-meta">{String(page.meta.reportId ?? "")}</p>
      <Link href={routes.home()} prefetch={false}>
        Return to dashboard
      </Link>
    </main>
  );
}
