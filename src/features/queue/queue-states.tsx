import { useTranslation } from "react-i18next";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import type { QueueSnapshot } from "@/domain/queue";
import {
  CircleAlertIcon,
  ListPlusIcon,
  SearchXIcon,
  XIcon,
} from "lucide-react";

export type QueueErrorKind = "loadQueue" | "saveQueue" | "runQueue";

export interface QueueError {
  kind: QueueErrorKind;
  message: string;
}

export function QueueErrorAlert({
  error,
  onDismiss,
}: {
  error: QueueError;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Alert variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{t(`errors.${error.kind}`)}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
      <AlertAction>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("common.close")}
          onClick={onDismiss}
        >
          <XIcon aria-hidden="true" />
        </Button>
      </AlertAction>
    </Alert>
  );
}

export function QueueLoadError({
  error,
  onRetry,
}: {
  error: QueueError;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl p-4 sm:p-6">
      <Empty className="min-h-72 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CircleAlertIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{t(`errors.${error.kind}`)}</EmptyTitle>
          <EmptyDescription>{error.message}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onRetry}>{t("common.retry")}</Button>
        </EmptyContent>
      </Empty>
    </main>
  );
}

export function QueueEmptyState({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  return (
    <Empty className="min-h-64 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ListPlusIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{t("states.emptyQueueTitle")}</EmptyTitle>
        <EmptyDescription>{t("states.emptyQueueDescription")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="create" onClick={onCreate}>
          <ListPlusIcon data-icon="inline-start" />
          {t("task.new")}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function QueueNoResults({ onClear }: { onClear: () => void }) {
  const { t } = useTranslation();
  return (
    <Empty className="min-h-64 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{t("states.noResultsTitle")}</EmptyTitle>
        <EmptyDescription>{t("states.noResultsDescription")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={onClear}>
          {t("filters.clear")}
        </Button>
      </EmptyContent>
    </Empty>
  );
}

export function QueueRunProgress({
  snapshot,
  plannedIds,
}: {
  snapshot: QueueSnapshot;
  plannedIds: string[];
}) {
  const { t } = useTranslation();
  const completed = plannedIds.filter((taskId) => {
    const status = snapshot.queue.tasks.find(
      (task) => task.id === taskId,
    )?.status;
    return (
      status === "succeeded" || status === "failed" || status === "blocked"
    );
  }).length;
  const total = plannedIds.length;
  const value = total === 0 ? 0 : (completed / total) * 100;

  return (
    <div
      className="flex flex-col gap-2 border-y bg-muted/35 px-3 py-2.5"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="inline-flex items-center gap-2 font-medium">
          <Spinner aria-hidden="true" />
          {t("states.runningQueue")}
        </span>
        <span className="text-muted-foreground">
          {t("states.runProgress", { completed, total })}
        </span>
      </div>
      <Progress value={value} aria-label={t("states.runningQueue")} />
    </div>
  );
}
