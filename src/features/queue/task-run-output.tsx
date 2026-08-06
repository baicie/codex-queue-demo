import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CircleAlertIcon,
  FileQuestionIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";

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
import { Field, FieldLabel } from "@/components/ui/field";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  RunArtifact,
  Task,
  TaskRunOutput,
  TaskRunSummary,
} from "@/domain/queue";
import { formatDateTime } from "@/i18n";
import type { DesktopClient } from "@/lib/desktop/client";

type ArtifactName = "finalOutput" | "events" | "stderr";

const artifactTabs: ArtifactName[] = ["finalOutput", "events", "stderr"];

export function TaskRunOutputSheet({
  task,
  queuePath,
  client,
  onOpenChange,
}: {
  task?: Task;
  queuePath: string;
  client: DesktopClient;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [refreshVersion, setRefreshVersion] = useState(0);

  return (
    <Sheet
      open={task !== undefined}
      onOpenChange={(open) => !open && onOpenChange(false)}
    >
      <SheetContent
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        showCloseButton={false}
      >
        <SheetHeader className="pr-20">
          <SheetTitle>{t("runOutput.title")}</SheetTitle>
          <SheetDescription>
            {t("runOutput.description", { title: task?.title ?? "" })}
          </SheetDescription>
        </SheetHeader>
        {task && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="absolute top-3 right-11"
            aria-label={t("runOutput.refresh")}
            onClick={() => setRefreshVersion((current) => current + 1)}
          >
            <RotateCwIcon />
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute top-3 right-3"
          aria-label={t("common.close")}
          onClick={() => onOpenChange(false)}
        >
          <XIcon />
        </Button>

        {task && (
          <TaskRunOutputContent
            key={`${queuePath}:${task.id}`}
            task={task}
            queuePath={queuePath}
            client={client}
            refreshVersion={refreshVersion}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function TaskRunOutputContent({
  task,
  queuePath,
  client,
  refreshVersion,
}: {
  task: Task;
  queuePath: string;
  client: DesktopClient;
  refreshVersion: number;
}) {
  const { t, i18n } = useTranslation();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [listState, setListState] = useState<{
    refreshVersion: number;
    runs: TaskRunSummary[];
    error?: string;
  }>();
  const [outputState, setOutputState] = useState<{
    refreshVersion: number;
    runId: string;
    output?: TaskRunOutput;
    error?: string;
  }>();

  useEffect(() => {
    let cancelled = false;
    void client
      .listTaskRuns(queuePath, task.id)
      .then((nextRuns) => {
        if (cancelled) return;
        setListState({ refreshVersion, runs: nextRuns });
        setSelectedRunId((currentRunId) =>
          currentRunId && nextRuns.some((run) => run.id === currentRunId)
            ? currentRunId
            : nextRuns[0]?.id,
        );
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setListState({
            refreshVersion,
            runs: [],
            error: toMessage(reason),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, queuePath, refreshVersion, task.id]);

  useEffect(() => {
    if (!selectedRunId) return;

    let cancelled = false;
    void client
      .readTaskRun(queuePath, task.id, selectedRunId)
      .then((nextOutput) => {
        if (!cancelled) {
          setOutputState({
            refreshVersion,
            runId: selectedRunId,
            output: nextOutput,
          });
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setOutputState({
            refreshVersion,
            runId: selectedRunId,
            error: toMessage(reason),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [client, queuePath, refreshVersion, selectedRunId, task.id]);

  const currentListState =
    listState?.refreshVersion === refreshVersion ? listState : undefined;
  const runs = currentListState?.runs ?? null;
  const listError = currentListState?.error;
  const selectedResponse =
    outputState?.refreshVersion === refreshVersion &&
    outputState.runId === selectedRunId
      ? outputState
      : undefined;
  const selectedOutput = selectedResponse?.output;
  const readError = selectedResponse?.error;

  return (
    <>
      {runs === null ? (
        <div
          className="flex flex-col gap-3 px-4"
          role="status"
          aria-busy="true"
          aria-label={t("runOutput.loadingRuns")}
        >
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : listError ? (
        <Alert variant="destructive" className="mx-4">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{t("runOutput.loadError")}</AlertTitle>
          <AlertDescription>{listError}</AlertDescription>
        </Alert>
      ) : runs.length === 0 ? (
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileQuestionIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("runOutput.emptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("runOutput.emptyDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <Field orientation="horizontal" className="px-4">
            <FieldLabel htmlFor="task-run-select">
              {t("runOutput.run")}
            </FieldLabel>
            <Select value={selectedRunId} onValueChange={setSelectedRunId}>
              <SelectTrigger id="task-run-select" className="min-w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectGroup>
                  {runs.map((run) => (
                    <SelectItem key={run.id} value={run.id}>
                      {t("runOutput.attempt", {
                        attempt: run.attempt,
                        startedAt: formatDateTime(run.startedAt, i18n.language),
                      })}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          {readError ? (
            <Alert variant="destructive" className="mx-4">
              <CircleAlertIcon aria-hidden="true" />
              <AlertTitle>{t("runOutput.loadError")}</AlertTitle>
              <AlertDescription>{readError}</AlertDescription>
            </Alert>
          ) : selectedOutput ? (
            <Tabs
              key={selectedOutput.run.id}
              defaultValue="finalOutput"
              className="min-h-0 flex-1 px-4 pb-4"
            >
              <TabsList>
                {artifactTabs.map((artifact) => (
                  <TabsTrigger key={artifact} value={artifact}>
                    {t(`runOutput.tabs.${artifact}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
              {artifactTabs.map((artifact) => (
                <TabsContent
                  key={artifact}
                  value={artifact}
                  className="min-h-0"
                >
                  <ArtifactOutput
                    artifact={selectedOutput[artifact]}
                    emptyLabel={t(`runOutput.empty.${artifact}`)}
                  />
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <div
              className="flex flex-col gap-3 px-4"
              role="status"
              aria-busy="true"
              aria-label={t("runOutput.loadingOutput")}
            >
              <Skeleton className="h-8 w-64" />
              <Skeleton className="h-64 w-full" />
            </div>
          )}
        </>
      )}
    </>
  );
}

function ArtifactOutput({
  artifact,
  emptyLabel,
}: {
  artifact: RunArtifact;
  emptyLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <ScrollArea className="h-full min-h-64">
      {artifact.content ? (
        <div className="flex min-h-64 flex-col gap-3 p-3">
          {artifact.truncated && (
            <Badge variant="secondary" className="self-start">
              {t("runOutput.truncated")}
            </Badge>
          )}
          <pre className="max-w-full min-w-0 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed">
            {artifact.content}
          </pre>
        </div>
      ) : (
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyTitle>{emptyLabel}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      )}
    </ScrollArea>
  );
}

function toMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}
