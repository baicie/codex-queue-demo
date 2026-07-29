import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type { Task } from "@/domain/queue";
import { DependencyPicker } from "@/features/queue/dependency-picker";
import { DiscardChangesDialog } from "@/features/queue/discard-changes-dialog";
import {
  createTaskDraft,
  taskFromDraft,
  type TaskDraftErrors,
  type TaskDraftField,
} from "@/features/queue/task-form";
import { XIcon } from "lucide-react";

export function TaskEditor({
  open,
  task,
  tasks,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  task?: Task;
  tasks: Task[];
  onOpenChange: (open: boolean) => void;
  onSave: (task: Task, previousId?: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [initialDraft] = useState(() => createTaskDraft(task));
  const [draft, setDraft] = useState(initialDraft);
  const [errors, setErrors] = useState<TaskDraftErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const isDirty = !draftsEqual(draft, initialDraft);

  function requestOpenChange(nextOpen: boolean) {
    if (!nextOpen && isSaving) return;
    if (!nextOpen && isDirty) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(nextOpen);
  }

  function update(field: TaskDraftField, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = taskFromDraft(draft, tasks, task);
    setErrors(result.errors);
    if (!result.task) return;

    setIsSaving(true);
    try {
      const saved = await onSave(result.task, task?.id);
      if (saved) onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={requestOpenChange}>
        <SheetContent className="w-full sm:max-w-xl" showCloseButton={false}>
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
            <SheetHeader className="pr-12">
              <SheetTitle>{t(task ? "task.edit" : "task.new")}</SheetTitle>
              <SheetDescription>
                {t(
                  task
                    ? "task.form.editDescription"
                    : "task.form.createDescription",
                )}
              </SheetDescription>
            </SheetHeader>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-3 right-3"
              aria-label={t("common.close")}
              disabled={isSaving}
              onClick={() => requestOpenChange(false)}
            >
              <XIcon />
            </Button>

            <ScrollArea className="min-h-0 flex-1 px-4">
              <FieldGroup className="pb-4">
                <TaskField
                  field="id"
                  label={t("task.id")}
                  value={draft.id}
                  error={errors.id}
                  description={t("task.idHint")}
                  onChange={update}
                />
                <TaskField
                  field="title"
                  label={t("task.title")}
                  value={draft.title}
                  error={errors.title}
                  onChange={update}
                />
                <TaskField
                  field="workspace"
                  label={t("task.workspace")}
                  value={draft.workspace}
                  error={errors.workspace}
                  onChange={update}
                />
                <Field data-invalid={Boolean(errors.prompt)}>
                  <FieldLabel htmlFor="task-prompt">
                    {t("task.prompt")}
                  </FieldLabel>
                  <Textarea
                    id="task-prompt"
                    value={draft.prompt}
                    onChange={(event) => update("prompt", event.target.value)}
                    aria-invalid={Boolean(errors.prompt)}
                    aria-errormessage={
                      errors.prompt ? "task-prompt-error" : undefined
                    }
                    rows={7}
                  />
                  <FieldError id="task-prompt-error">
                    {translateError(t, errors.prompt)}
                  </FieldError>
                </Field>
                <TaskField
                  field="priority"
                  label={t("task.priority")}
                  value={draft.priority}
                  error={errors.priority}
                  type="number"
                  onChange={update}
                />
                <DependencyPicker
                  currentId={draft.id}
                  originalId={task?.id}
                  tasks={tasks}
                  value={draft.dependsOn}
                  onChange={(dependsOn) =>
                    setDraft((current) => ({ ...current, dependsOn }))
                  }
                />
              </FieldGroup>
            </ScrollArea>

            <Separator />
            <SheetFooter className="flex-row justify-end">
              <Button
                type="button"
                variant="outline"
                disabled={isSaving}
                onClick={() => requestOpenChange(false)}
              >
                {t("task.cancel")}
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving && <Spinner data-icon="inline-start" />}
                {t("task.save")}
              </Button>
            </SheetFooter>
          </form>
        </SheetContent>
      </Sheet>
      <DiscardChangesDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        onDiscard={() => onOpenChange(false)}
      />
    </>
  );
}

function draftsEqual(
  left: ReturnType<typeof createTaskDraft>,
  right: ReturnType<typeof createTaskDraft>,
) {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.workspace === right.workspace &&
    left.prompt === right.prompt &&
    left.priority === right.priority &&
    left.dependsOn.length === right.dependsOn.length &&
    left.dependsOn.every(
      (dependency, index) => dependency === right.dependsOn[index],
    )
  );
}

function TaskField({
  field,
  label,
  value,
  error,
  description,
  type = "text",
  onChange,
}: {
  field: TaskDraftField;
  label: string;
  value: string;
  error?: string;
  description?: string;
  type?: "text" | "number";
  onChange: (field: TaskDraftField, value: string) => void;
}) {
  const { t } = useTranslation();
  const inputId = `task-${field}`;
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <Input
        id={inputId}
        type={type}
        value={value}
        onChange={(event) => onChange(field, event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={description ? descriptionId : undefined}
        aria-errormessage={error ? errorId : undefined}
      />
      {description && (
        <FieldDescription id={descriptionId}>{description}</FieldDescription>
      )}
      <FieldError id={errorId}>{translateError(t, error)}</FieldError>
    </Field>
  );
}

function translateError(t: (key: string) => string, error?: string) {
  return error ? t(`task.validation.${error}`) : undefined;
}
