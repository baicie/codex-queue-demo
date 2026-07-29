import { useTranslation } from "react-i18next";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import type { Task } from "@/domain/queue";

export function DependencyPicker({
  currentId,
  originalId,
  tasks,
  value,
  onChange,
}: {
  currentId: string;
  originalId?: string;
  tasks: Task[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const { t } = useTranslation();
  const sourceId = originalId ?? currentId;
  const candidates = tasks.filter(
    (task) => task.id !== currentId && task.id !== originalId,
  );

  return (
    <FieldSet>
      <FieldLegend variant="label">{t("task.dependencies")}</FieldLegend>
      <FieldDescription>{t("task.placeholders.dependencies")}</FieldDescription>
      {candidates.length === 0 ? (
        <FieldDescription>{t("task.noDependencies")}</FieldDescription>
      ) : (
        <FieldGroup className="gap-3">
          {candidates.map((task) => {
            const inputId = `dependency-${task.id}`;
            const createsCycle = taskDependsOn(task.id, sourceId, tasks);
            return (
              <Field
                key={task.id}
                orientation="horizontal"
                data-disabled={createsCycle}
              >
                <Checkbox
                  id={inputId}
                  checked={value.includes(task.id)}
                  disabled={createsCycle}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked
                        ? [...value, task.id]
                        : value.filter((id) => id !== task.id),
                    )
                  }
                />
                <FieldLabel htmlFor={inputId} className="min-w-0 font-normal">
                  <span className="truncate">{task.title}</span>
                  <span className="text-muted-foreground">{task.id}</span>
                  {createsCycle && (
                    <span className="text-muted-foreground">
                      {t("task.dependencyCreatesCycle")}
                    </span>
                  )}
                </FieldLabel>
              </Field>
            );
          })}
        </FieldGroup>
      )}
    </FieldSet>
  );
}

function taskDependsOn(
  taskId: string,
  targetId: string,
  tasks: Task[],
): boolean {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const pending = [taskId];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(tasksById.get(current)?.dependsOn ?? []));
  }

  return false;
}
