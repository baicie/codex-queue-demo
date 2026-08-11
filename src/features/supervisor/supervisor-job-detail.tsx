import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  ProviderHealth,
  SupervisorEvent,
  SupervisorJob,
} from "@/domain/supervisor";
import { JobStatusBadge } from "@/features/supervisor/supervisor-status-badge";
import { cn } from "@/lib/utils";
import {
  CheckIcon,
  CircleDotIcon,
  Clock3Icon,
  FolderIcon,
  GoalIcon,
  HashIcon,
  PauseIcon,
  PlayIcon,
  RotateCwIcon,
  TerminalSquareIcon,
} from "lucide-react";

export function SupervisorJobDetail({
  job,
  provider,
  readOnly,
  busyAction,
  onResume,
  onPause,
  onComplete,
}: {
  job: SupervisorJob;
  provider: ProviderHealth;
  readOnly: boolean;
  busyAction?: string;
  onResume: () => void;
  onPause: () => void;
  onComplete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const canResume =
    provider.state !== "offline" &&
    ["waiting", "provider_down", "paused", "failed"].includes(job.status);
  const isComplete = job.status === "completed";

  return (
    <section
      className="min-w-0 rounded-md border bg-card"
      aria-labelledby="job-detail-title"
    >
      <header className="flex flex-col gap-4 border-b p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <JobStatusBadge status={job.status} />
            <Badge variant="outline" className="font-mono font-normal">
              {job.threadId}
            </Badge>
          </div>
          <h2
            id="job-detail-title"
            className="text-lg font-semibold sm:text-xl"
          >
            {job.title}
          </h2>
          <p className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <FolderIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{job.workspace}</span>
          </p>
        </div>
        {!readOnly && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {!isComplete && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={t("supervisor.actions.pause")}
                    disabled={Boolean(busyAction) || job.status === "paused"}
                    onClick={onPause}
                  >
                    <PauseIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("supervisor.actions.pause")}</TooltipContent>
              </Tooltip>
            )}
            <Button
              variant="outline"
              disabled={Boolean(busyAction) || isComplete}
              onClick={onComplete}
            >
              <CheckIcon data-icon="inline-start" />
              {t("supervisor.actions.completeGoal")}
            </Button>
            <Button
              disabled={Boolean(busyAction) || !canResume}
              onClick={onResume}
            >
              {busyAction === "resume" ? (
                <RotateCwIcon
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : (
                <PlayIcon data-icon="inline-start" />
              )}
              {t("supervisor.actions.resume")}
            </Button>
          </div>
        )}
      </header>

      {job.status === "waiting" && (
        <RecoveryBand job={job} provider={provider} />
      )}

      <div className="grid gap-0 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 p-4 sm:p-5">
          <section aria-labelledby="goal-heading">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3
                id="goal-heading"
                className="flex items-center gap-2 text-sm font-semibold"
              >
                <GoalIcon className="size-4 text-create" aria-hidden="true" />
                {t("supervisor.goal.title")}
              </h3>
              <Badge
                variant={
                  job.goal.status === "complete" ? "success" : "secondary"
                }
              >
                {t(`supervisor.goal.status.${job.goal.status}`)}
              </Badge>
            </div>
            <p className="text-sm leading-6 text-foreground/90">
              {job.goal.objective}
            </p>
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-y py-3 text-xs sm:grid-cols-4">
              <Metric
                label={t("supervisor.detail.turns")}
                value={String(job.turnCount)}
              />
              <Metric
                label={t("supervisor.detail.attempts")}
                value={formatAttempts(job)}
              />
              <Metric
                label={t("supervisor.detail.tokens")}
                value={formatTokenUsage(job, i18n.language)}
              />
              <Metric
                label={t("supervisor.detail.updated")}
                value={formatTime(job.updatedAt, i18n.language)}
              />
            </div>
          </section>

          <section className="mt-5" aria-labelledby="timeline-heading">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3
                id="timeline-heading"
                className="flex items-center gap-2 text-sm font-semibold"
              >
                <TerminalSquareIcon
                  className="size-4 text-info"
                  aria-hidden="true"
                />
                {t("supervisor.timeline.title")}
              </h3>
              <span className="text-xs text-muted-foreground">
                {t("supervisor.timeline.events", { count: job.events.length })}
              </span>
            </div>
            <ol className="space-y-0">
              {[...job.events].reverse().map((event, index) => (
                <TimelineEvent
                  key={event.id}
                  event={event}
                  last={index === job.events.length - 1}
                  locale={i18n.language}
                />
              ))}
            </ol>
          </section>
        </div>

        <aside className="border-t bg-muted/20 p-4 xl:border-t-0 xl:border-l xl:p-5">
          <h3 className="text-sm font-semibold">
            {t("supervisor.context.title")}
          </h3>
          <dl className="mt-4 space-y-4">
            <ContextItem
              icon={HashIcon}
              label={t("supervisor.context.jobId")}
              value={job.id}
              mono
            />
            <ContextItem
              icon={TerminalSquareIcon}
              label={t("supervisor.context.threadId")}
              value={job.threadId}
              mono
            />
            <ContextItem
              icon={FolderIcon}
              label={t("supervisor.context.workspace")}
              value={job.workspace}
            />
            <ContextItem
              icon={Clock3Icon}
              label={t("supervisor.context.created")}
              value={formatDateTime(job.createdAt, i18n.language)}
            />
          </dl>
          {job.lastError && (
            <div className="mt-5 border-t pt-4">
              <p className="text-xs font-medium text-destructive">
                {t("supervisor.context.lastError")}
              </p>
              <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                {job.lastError}
              </p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function RecoveryBand({
  job,
  provider,
}: {
  job: SupervisorJob;
  provider: ProviderHealth;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="border-b bg-warning/8 px-4 py-3.5 sm:px-5" role="status">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-warning/18 text-warning-text">
            <Clock3Icon className="size-4" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-semibold">
              {t("supervisor.recovery.waiting")}
            </p>
            <p className="text-xs text-muted-foreground">
              {job.nextRetryAt
                ? t("supervisor.recovery.nextProbe", {
                    value: formatTime(job.nextRetryAt, i18n.language),
                  })
                : t("supervisor.recovery.awaitingHealth")}
            </p>
          </div>
        </div>
        <span className="text-xs font-medium text-warning-text">
          {t("supervisor.recovery.providerState", {
            value: t(`supervisor.provider.state.${provider.state}`),
          })}
        </span>
      </div>
      <Progress
        value={provider.state === "offline" ? 34 : 82}
        className="mt-3 [&_[data-slot=progress-indicator]]:bg-warning"
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <p className="mt-1 truncate font-medium tabular-nums" title={value}>
        {value}
      </p>
    </div>
  );
}

function TimelineEvent({
  event,
  last,
  locale,
}: {
  event: SupervisorEvent;
  last: boolean;
  locale: string;
}) {
  const accent = eventTone(event.kind);
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)] gap-3">
      <div className="flex flex-col items-center">
        <CircleDotIcon
          className={cn("size-4 shrink-0", accent)}
          aria-hidden="true"
        />
        {!last && (
          <Separator orientation="vertical" className="my-1 min-h-10 flex-1" />
        )}
      </div>
      <div className={cn("min-w-0 pb-5", last && "pb-0")}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-sm font-medium">{event.title}</p>
          <time
            className="text-[11px] text-muted-foreground"
            dateTime={event.at}
          >
            {formatTime(event.at, locale)}
          </time>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {event.detail}
        </p>
      </div>
    </li>
  );
}

function ContextItem({
  icon: Icon,
  label,
  value,
  mono = false,
}: {
  icon: typeof HashIcon;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-1">
      <Icon
        className="mt-0.5 size-3.5 text-muted-foreground"
        aria-hidden="true"
      />
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "col-start-2 break-words text-xs leading-5",
          mono && "font-mono",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function eventTone(kind: SupervisorEvent["kind"]): string {
  if (
    kind === "goal_completed" ||
    kind === "provider_restored" ||
    kind === "turn_completed"
  )
    return "text-success";
  if (
    kind === "provider_down" ||
    kind === "retry_scheduled" ||
    kind === "turn_failed"
  )
    return "text-warning-text";
  if (kind === "job_paused" || kind === "turn_interrupted")
    return "text-muted-foreground";
  return "text-info";
}

function formatTokenUsage(job: SupervisorJob, locale: string): string {
  const formatter = new Intl.NumberFormat(locale);
  const used = formatter.format(job.tokensUsed);
  return job.goal.tokenBudget > 0
    ? `${used} / ${formatter.format(job.goal.tokenBudget)}`
    : used;
}

function formatAttempts(job: SupervisorJob): string {
  return job.maxAttempts > 0
    ? `${job.attempts} / ${job.maxAttempts}`
    : String(job.attempts);
}

function formatTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDateTime(value: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
