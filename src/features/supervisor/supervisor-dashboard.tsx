import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  summarizeSupervisor,
  type ProviderState,
  type SupervisorJob,
  type SupervisorSnapshot,
} from "@/domain/supervisor";
import { SupervisorJobDetail } from "@/features/supervisor/supervisor-job-detail";
import { JobStatusBadge } from "@/features/supervisor/supervisor-status-badge";
import {
  supervisorClient,
  type SupervisorClient,
} from "@/lib/supervisor/client";
import { cn } from "@/lib/utils";
import {
  ActivityIcon,
  AlertCircleIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  Clock3Icon,
  CloudOffIcon,
  InboxIcon,
  ListPlusIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  WifiIcon,
} from "lucide-react";

type JobFilter = "all" | "active" | "waiting" | "completed";
type BusyAction =
  "health" | "outage" | "resume" | "pause" | "complete" | "reset";

export function SupervisorDashboard({
  client = supervisorClient,
  onOpenQueue,
}: {
  client?: SupervisorClient;
  onOpenQueue: () => void;
}) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<SupervisorSnapshot>();
  const [filter, setFilter] = useState<JobFilter>("all");
  const [busyAction, setBusyAction] = useState<BusyAction>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void client
      .load()
      .then((nextSnapshot) => {
        if (!cancelled) setSnapshot(nextSnapshot);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(messageFrom(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (snapshot?.source !== "codex") return;

    let cancelled = false;
    let refreshing = false;
    const interval = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void client
        .load()
        .then((nextSnapshot) => {
          if (!cancelled) {
            setSnapshot(nextSnapshot);
            setError(undefined);
          }
        })
        .catch((reason: unknown) => {
          if (!cancelled) setError(messageFrom(reason));
        })
        .finally(() => {
          refreshing = false;
        });
    }, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [client, snapshot?.source]);

  const selectedJob = snapshot?.jobs.find(
    (job) => job.id === snapshot.selectedJobId,
  );
  const summary = snapshot ? summarizeSupervisor(snapshot) : undefined;
  const filteredJobs = useMemo(
    () => snapshot?.jobs.filter((job) => matchesFilter(job, filter)) ?? [],
    [filter, snapshot],
  );

  async function perform(
    action: BusyAction,
    operation: () => Promise<SupervisorSnapshot>,
    successKey: string,
  ) {
    if (busyAction) return;
    setBusyAction(action);
    setError(undefined);
    try {
      const nextSnapshot = await operation();
      setSnapshot(nextSnapshot);
      toast.success(t(successKey));
    } catch (reason) {
      const nextError = messageFrom(reason);
      setError(nextError);
      toast.error(t("supervisor.toast.actionFailed"), {
        description: nextError,
      });
    } finally {
      setBusyAction(undefined);
    }
  }

  if (!snapshot || !summary) {
    return error ? (
      <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-5xl items-center p-4 md:min-h-screen md:p-8">
        <Alert variant="destructive">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>{t("supervisor.error.loadTitle")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </main>
    ) : (
      <SupervisorSkeleton />
    );
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-[1480px] flex-col px-4 py-5 md:min-h-screen md:px-6 md:py-6 xl:px-8">
      <header className="flex flex-col gap-4 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <ActivityIcon className="size-3.5" aria-hidden="true" />
            {t("supervisor.header.runtime")}
          </div>
          <h1 className="text-2xl font-semibold sm:text-3xl">
            {t("supervisor.header.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("supervisor.header.summary", {
              jobs: snapshot.jobs.length,
              active: summary.active,
              waiting: summary.waiting,
            })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onOpenQueue}>
            <ListPlusIcon data-icon="inline-start" />
            {t("supervisor.header.openQueue")}
          </Button>
          <Button
            onClick={() =>
              void perform(
                "health",
                () =>
                  snapshot.readOnly
                    ? client.load()
                    : client.markProviderHealthy(),
                snapshot.readOnly
                  ? "supervisor.toast.refreshed"
                  : "supervisor.toast.providerHealthy",
              )
            }
            disabled={Boolean(busyAction)}
          >
            <RefreshCwIcon
              data-icon="inline-start"
              className={cn(busyAction === "health" && "animate-spin")}
            />
            {t("supervisor.provider.checkNow")}
          </Button>
        </div>
      </header>

      <ProviderBand
        snapshot={snapshot}
        busy={Boolean(busyAction)}
        outageDisabled={!selectedJob || selectedJob.status === "completed"}
        onOutage={() => {
          if (!selectedJob) return;
          void perform(
            "outage",
            () => client.markProviderDown(selectedJob.id),
            "supervisor.toast.providerDown",
          );
        }}
        onReset={() =>
          void perform(
            "reset",
            () => client.resetDemo(),
            "supervisor.toast.demoReset",
          )
        }
      />

      {error && (
        <Alert variant="destructive" className="mt-4">
          <AlertCircleIcon aria-hidden="true" />
          <AlertTitle>{t("supervisor.error.actionTitle")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <SummaryStrip summary={summary} />

      <div className="grid flex-1 gap-5 py-5 lg:grid-cols-[minmax(280px,0.38fr)_minmax(0,0.62fr)] xl:gap-7">
        {snapshot.jobs.length === 0 ? (
          <SupervisorEmptyState />
        ) : (
          <>
            <section
              className="min-w-0"
              aria-labelledby="supervisor-jobs-heading"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2
                  id="supervisor-jobs-heading"
                  className="text-sm font-semibold"
                >
                  {t("supervisor.jobs.title")}
                </h2>
                <span className="text-xs text-muted-foreground">
                  {t("supervisor.jobs.visible", { count: filteredJobs.length })}
                </span>
              </div>
              <div className="mb-3 overflow-x-auto pb-1">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  value={filter}
                  onValueChange={(value) =>
                    value && setFilter(value as JobFilter)
                  }
                  aria-label={t("supervisor.jobs.filterLabel")}
                >
                  {(
                    ["all", "active", "waiting", "completed"] as JobFilter[]
                  ).map((value) => (
                    <ToggleGroupItem
                      key={value}
                      value={value}
                      aria-label={t(`supervisor.jobs.filter.${value}`)}
                    >
                      {t(`supervisor.jobs.filter.${value}`)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <div className="flex flex-col gap-2">
                {filteredJobs.map((job) => (
                  <JobListItem
                    key={job.id}
                    job={job}
                    selected={job.id === selectedJob?.id}
                    onClick={() => {
                      setSnapshot((current) =>
                        current
                          ? { ...current, selectedJobId: job.id }
                          : current,
                      );
                      void client
                        .selectJob(job.id)
                        .catch((reason: unknown) =>
                          setError(messageFrom(reason)),
                        );
                    }}
                  />
                ))}
                {filteredJobs.length === 0 && (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    {t("supervisor.jobs.noMatches")}
                  </p>
                )}
              </div>
            </section>

            {selectedJob && (
              <SupervisorJobDetail
                job={selectedJob}
                provider={snapshot.provider}
                readOnly={snapshot.readOnly}
                busyAction={busyAction}
                onResume={() =>
                  void perform(
                    "resume",
                    () => client.resumeJob(selectedJob.id),
                    "supervisor.toast.resumed",
                  )
                }
                onPause={() =>
                  void perform(
                    "pause",
                    () => client.pauseJob(selectedJob.id),
                    "supervisor.toast.paused",
                  )
                }
                onComplete={() =>
                  void perform(
                    "complete",
                    () => client.completeGoal(selectedJob.id),
                    "supervisor.toast.goalCompleted",
                  )
                }
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}

function ProviderBand({
  snapshot,
  busy,
  outageDisabled,
  onOutage,
  onReset,
}: {
  snapshot: SupervisorSnapshot;
  busy: boolean;
  outageDisabled: boolean;
  onOutage: () => void;
  onReset: () => void;
}) {
  const { t, i18n } = useTranslation();
  const provider = snapshot.provider;
  return (
    <section className="flex flex-col gap-3 border-y bg-muted/25 px-1 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-3">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-md",
            provider.state === "healthy" && "bg-success/12 text-success",
            provider.state === "degraded" && "bg-warning/18 text-warning-text",
            provider.state === "offline" &&
              "bg-destructive/10 text-destructive",
          )}
        >
          {provider.state === "offline" ? <CloudOffIcon /> : <RadioTowerIcon />}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{provider.name}</p>
            <ProviderBadge state={provider.state} />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {provider.baseUrl} · {provider.message}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <WifiIcon className="size-3.5" aria-hidden="true" />
          {provider.latencyMs === null
            ? t("common.notAvailable")
            : t("supervisor.provider.latency", { value: provider.latencyMs })}
        </span>
        <span>
          {t("supervisor.provider.checked", {
            value: new Intl.DateTimeFormat(i18n.language, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            }).format(new Date(provider.checkedAt)),
          })}
        </span>
        {!snapshot.readOnly && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("supervisor.provider.markOutage")}
                  disabled={busy || outageDisabled}
                  onClick={onOutage}
                >
                  <CloudOffIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t("supervisor.provider.markOutage")}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("supervisor.provider.resetDemo")}
                  disabled={busy}
                  onClick={onReset}
                >
                  <RotateCcwIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t("supervisor.provider.resetDemo")}
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </section>
  );
}

function SummaryStrip({
  summary,
}: {
  summary: ReturnType<typeof summarizeSupervisor>;
}) {
  const { t } = useTranslation();
  const items = [
    {
      key: "active",
      value: summary.active,
      icon: CircleDotIcon,
      color: "text-info",
    },
    {
      key: "waiting",
      value: summary.waiting,
      icon: Clock3Icon,
      color: "text-warning-text",
    },
    {
      key: "completed",
      value: summary.completed,
      icon: CheckCircle2Icon,
      color: "text-success",
    },
    {
      key: "attention",
      value: summary.attention,
      icon: ShieldCheckIcon,
      color: "text-muted-foreground",
    },
  ] as const;
  return (
    <section
      className="grid grid-cols-2 border-b sm:grid-cols-4"
      aria-label={t("supervisor.summary.title")}
    >
      {items.map(({ key, value, icon: Icon, color }, index) => (
        <div
          key={key}
          className={cn(
            "flex min-h-20 items-center gap-3 py-4",
            index % 2 === 0 ? "pr-3" : "border-l pl-3",
            index >= 2 && "border-t sm:border-t-0",
            index > 0 && "sm:border-l sm:pl-4",
            index > 0 && "sm:ml-4",
          )}
        >
          <Icon className={cn("size-4", color)} aria-hidden="true" />
          <div>
            <p className="text-xl font-semibold tabular-nums">{value}</p>
            <p className="text-xs text-muted-foreground">
              {t(`supervisor.summary.${key}`)}
            </p>
          </div>
        </div>
      ))}
    </section>
  );
}

function SupervisorEmptyState() {
  const { t } = useTranslation();
  return (
    <Empty className="min-h-80 rounded-md border lg:col-span-2">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <InboxIcon aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{t("supervisor.empty.title")}</EmptyTitle>
        <EmptyDescription>{t("supervisor.empty.description")}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function JobListItem({
  job,
  selected,
  onClick,
}: {
  job: SupervisorJob;
  selected: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={cn(
        "min-h-24 w-full rounded-md border bg-card p-3 text-left transition-colors",
        selected
          ? "border-foreground/40 bg-foreground/[0.035] shadow-sm"
          : "hover:border-foreground/25 hover:bg-muted/30",
      )}
      aria-pressed={selected}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{job.title}</p>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {job.threadId}
          </p>
        </div>
        <JobStatusBadge status={job.status} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="truncate">{job.workspace}</span>
        <span className="shrink-0 tabular-nums">
          {t("supervisor.jobs.turn", { value: job.turnCount })}
        </span>
      </div>
    </button>
  );
}

function ProviderBadge({ state }: { state: ProviderState }) {
  const { t } = useTranslation();
  const variant =
    state === "healthy"
      ? "success"
      : state === "offline"
        ? "destructive"
        : "warning";
  return (
    <Badge variant={variant}>{t(`supervisor.provider.state.${state}`)}</Badge>
  );
}

function matchesFilter(job: SupervisorJob, filter: JobFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active")
    return ["queued", "running", "resuming"].includes(job.status);
  if (filter === "waiting")
    return ["provider_down", "waiting", "paused", "failed"].includes(
      job.status,
    );
  return job.status === "completed";
}

function SupervisorSkeleton() {
  const { t } = useTranslation();
  return (
    <main
      className="mx-auto flex min-h-screen w-full max-w-[1480px] flex-col gap-4 p-4 md:p-8"
      aria-busy="true"
      aria-label={t("supervisor.loading")}
    >
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-5 lg:grid-cols-[minmax(280px,0.38fr)_minmax(0,0.62fr)]">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-[32rem] w-full" />
      </div>
    </main>
  );
}

function messageFrom(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
