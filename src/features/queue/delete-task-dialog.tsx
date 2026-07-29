import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import type { Task } from "@/domain/queue";
import { Trash2Icon } from "lucide-react";

export function DeleteTaskDialog({
  task,
  onOpenChange,
  onConfirm,
}: {
  task?: Task;
  onOpenChange: (open: boolean) => void;
  onConfirm: (task: Task) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [isDeleting, setIsDeleting] = useState(false);

  async function confirm() {
    if (!task) return;
    setIsDeleting(true);
    try {
      const deleted = await onConfirm(task);
      if (deleted) onOpenChange(false);
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <AlertDialog open={Boolean(task)} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia>
            <Trash2Icon aria-hidden="true" />
          </AlertDialogMedia>
          <AlertDialogTitle>{t("task.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("task.deleteDescription", { title: task?.title ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isDeleting}
            onClick={(event) => {
              event.preventDefault();
              void confirm();
            }}
          >
            {isDeleting && <Spinner data-icon="inline-start" />}
            {t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
