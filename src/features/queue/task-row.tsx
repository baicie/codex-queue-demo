import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { BlockedReason, Task, TaskStatus } from "@/domain/queue";
import { formatDateTime } from "@/i18n";
import {
  CircleEllipsisIcon,
  Clock3Icon,
  FolderIcon,
  GitBranchIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";

const statusVariants: Record<
  TaskStatus,
  "secondary" | "info" | "success" | "destructive" | "warning"
> = {
  pending: "secondary",
  running: "info",
  succeeded: "success",
  failed: "destructive",
  blocked: "warning",
};

export function TaskRow({
  task,
  position,
  blockedReason,
  disabled,
  onEdit,
  onDelete,
  onRequeue,
}: {
  task: Task;
  position?: number;
  blockedReason?: BlockedReason;
  disabled?: boolean;
  onEdit: (task: Task) => void;
  onDelete: (task: Task) => void;
  onRequeue: (task: Task) => void;
}) {
  const { t, i18n } = useTranslation();
  const effectiveStatus = blockedReason ? "blocked" : task.status;
  const lastError = blockedReason
    ? t(`task.blockedReason.${blockedReason.reasonCode}`, {
        dependencyId: blockedReason.dependencyId,
      })
    : task.lastError;
  const canRequeue = task.status !== "pending" && task.status !== "running";
  return (
    <Card
      size="sm"
      variant={effectiveStatus === "running" ? "active" : "default"}
    >
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          {task.title}
        </CardTitle>
        <CardDescription className="flex min-w-0 items-center gap-1.5">
          <FolderIcon aria-hidden="true" />
          <span className="truncate">{task.workspace}</span>
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Badge variant={statusVariants[effectiveStatus]}>
            {t(`status.${effectiveStatus}`)}
          </Badge>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("accessibility.taskActions", {
                  title: task.title,
                })}
                disabled={disabled}
              >
                <CircleEllipsisIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => onEdit(task)}>
                  <PencilIcon />
                  {t("toolbar.editTask")}
                </DropdownMenuItem>
                {canRequeue && (
                  <DropdownMenuItem onSelect={() => onRequeue(task)}>
                    <RotateCcwIcon />
                    {t("task.requeue")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => onDelete(task)}
                >
                  <Trash2Icon />
                  {t("toolbar.deleteTask")}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {position !== undefined && (
          <span>{t("task.planPosition", { position: position + 1 })}</span>
        )}
        <span>
          {t("task.priority")}: {task.priority}
        </span>
        <span className="inline-flex items-center gap-1">
          <GitBranchIcon aria-hidden="true" />
          {t("task.meta.dependencyCount", { count: task.dependsOn.length })}
        </span>
        <span className="inline-flex items-center gap-1">
          <RotateCcwIcon aria-hidden="true" />
          {t("task.attempts", { count: task.attempts ?? 0 })}
        </span>
        {task.nextRetryAt && (
          <span className="inline-flex items-center gap-1">
            <Clock3Icon aria-hidden="true" />
            {t("task.nextRetry")}:{" "}
            {formatDateTime(task.nextRetryAt, i18n.language)}
          </span>
        )}
        {lastError && (
          <span className="w-full truncate text-destructive" title={lastError}>
            {t("task.lastError")}: {lastError}
          </span>
        )}
      </CardContent>
    </Card>
  );
}
