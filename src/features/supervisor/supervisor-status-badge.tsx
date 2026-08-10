import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import type { SupervisorJob } from "@/domain/supervisor";

export function JobStatusBadge({
  status,
}: {
  status: SupervisorJob["status"];
}) {
  const { t } = useTranslation();
  const variant =
    status === "completed"
      ? "success"
      : status === "failed"
        ? "destructive"
        : status === "waiting" || status === "provider_down"
          ? "warning"
          : status === "running" || status === "resuming"
            ? "info"
            : "secondary";
  return <Badge variant={variant}>{t(`supervisor.status.${status}`)}</Badge>;
}
