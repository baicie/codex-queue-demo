import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
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
import { Switch } from "@/components/ui/switch";
import type { Queue } from "@/domain/queue";
import { DiscardChangesDialog } from "@/features/queue/discard-changes-dialog";
import { XIcon } from "lucide-react";

type NumericField = "maxAttempts" | "initialDelaySeconds" | "maxDelaySeconds";
type SettingsErrors = Partial<Record<NumericField, string>>;

export function QueueSettings({
  open,
  queue,
  codexBin,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  queue: Queue;
  codexBin: string;
  onOpenChange: (open: boolean) => void;
  onSave: (queue: Queue, codexBin: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [initialSettings] = useState(() => ({
    launchApp: queue.launchApp,
    retry: retryStrings(queue),
    binary: codexBin,
  }));
  const [launchApp, setLaunchApp] = useState(initialSettings.launchApp);
  const [retry, setRetry] = useState(initialSettings.retry);
  const [binary, setBinary] = useState(initialSettings.binary);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const isDirty =
    launchApp !== initialSettings.launchApp ||
    binary !== initialSettings.binary ||
    retry.maxAttempts !== initialSettings.retry.maxAttempts ||
    retry.initialDelaySeconds !== initialSettings.retry.initialDelaySeconds ||
    retry.maxDelaySeconds !== initialSettings.retry.maxDelaySeconds;

  function requestOpenChange(nextOpen: boolean) {
    if (!nextOpen && isSaving) return;
    if (!nextOpen && isDirty) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(nextOpen);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = parseRetry(retry);
    setErrors(result.errors);
    if (!result.value) return;
    setIsSaving(true);
    try {
      const saved = await onSave(
        { ...queue, launchApp, retryPolicy: result.value },
        binary.trim(),
      );
      if (saved) onOpenChange(false);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={requestOpenChange}>
        <SheetContent className="w-full sm:max-w-md" showCloseButton={false}>
          <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
            <SheetHeader className="pr-12">
              <SheetTitle>{t("settings.title")}</SheetTitle>
              <SheetDescription>{t("settings.description")}</SheetDescription>
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
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="launch-app">
                      {t("settings.launchApp")}
                    </FieldLabel>
                  </FieldContent>
                  <Switch
                    id="launch-app"
                    checked={launchApp}
                    onCheckedChange={setLaunchApp}
                  />
                </Field>

                <FieldSet>
                  <FieldLegend>{t("settings.retryPolicy")}</FieldLegend>
                  <FieldDescription>
                    {t("retryPolicy.description")}{" "}
                    {t("retryPolicy.exponentialBackoffDescription")}
                  </FieldDescription>
                  <FieldGroup>
                    <NumberField
                      field="maxAttempts"
                      label={t("settings.maxAttempts")}
                      value={retry.maxAttempts}
                      error={errors.maxAttempts}
                      min={1}
                      max={20}
                      onChange={(value) =>
                        setRetry((current) => ({
                          ...current,
                          maxAttempts: value,
                        }))
                      }
                    />
                    <NumberField
                      field="initialDelaySeconds"
                      label={t("retryPolicy.initialDelaySeconds")}
                      value={retry.initialDelaySeconds}
                      error={errors.initialDelaySeconds}
                      min={1}
                      max={86400}
                      onChange={(value) =>
                        setRetry((current) => ({
                          ...current,
                          initialDelaySeconds: value,
                        }))
                      }
                    />
                    <NumberField
                      field="maxDelaySeconds"
                      label={t("retryPolicy.maxDelaySeconds")}
                      value={retry.maxDelaySeconds}
                      error={errors.maxDelaySeconds}
                      min={1}
                      max={86400}
                      onChange={(value) =>
                        setRetry((current) => ({
                          ...current,
                          maxDelaySeconds: value,
                        }))
                      }
                    />
                  </FieldGroup>
                </FieldSet>

                <Field>
                  <FieldLabel htmlFor="codex-bin">
                    {t("settings.codexBin")}
                  </FieldLabel>
                  <Input
                    id="codex-bin"
                    value={binary}
                    placeholder={t("settings.codexBinPlaceholder")}
                    onChange={(event) => setBinary(event.target.value)}
                  />
                </Field>
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
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving && <Spinner data-icon="inline-start" />}
                {t("common.save")}
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

function NumberField({
  field,
  label,
  value,
  error,
  min,
  max,
  onChange,
}: {
  field: NumericField;
  label: string;
  value: string;
  error?: string;
  min: number;
  max: number;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const inputId = `settings-${field}`;
  const errorId = `${inputId}-error`;
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      <Input
        id={inputId}
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-errormessage={error ? errorId : undefined}
      />
      <FieldError id={errorId}>
        {error ? t(`settings.validation.${error}`) : undefined}
      </FieldError>
    </Field>
  );
}

function retryStrings(queue: Queue) {
  return {
    maxAttempts: String(queue.retryPolicy.maxAttempts),
    initialDelaySeconds: String(queue.retryPolicy.initialDelaySeconds),
    maxDelaySeconds: String(queue.retryPolicy.maxDelaySeconds),
  };
}

function parseRetry(retry: ReturnType<typeof retryStrings>) {
  const maxAttempts = Number(retry.maxAttempts);
  const initialDelaySeconds = Number(retry.initialDelaySeconds);
  const maxDelaySeconds = Number(retry.maxDelaySeconds);
  const errors: SettingsErrors = {};
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    errors.maxAttempts = "maxAttempts";
  }
  if (!Number.isInteger(initialDelaySeconds) || initialDelaySeconds < 1) {
    errors.initialDelaySeconds = "initialDelay";
  }
  if (
    !Number.isInteger(maxDelaySeconds) ||
    maxDelaySeconds < initialDelaySeconds ||
    maxDelaySeconds > 86400
  ) {
    errors.maxDelaySeconds = "maxDelay";
  }
  return {
    errors,
    value:
      Object.keys(errors).length === 0
        ? { maxAttempts, initialDelaySeconds, maxDelaySeconds }
        : undefined,
  };
}
