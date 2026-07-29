import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { QueueSnapshot } from "@/domain/queue";
import { normalizeLocale, type AppLocale } from "@/i18n";
import {
  FilePlus2Icon,
  FolderOpenIcon,
  LanguagesIcon,
  ListChecksIcon,
  MonitorIcon,
  MoonIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SaveIcon,
  Settings2Icon,
  SunIcon,
  type LucideIcon,
} from "lucide-react";

export type FileAction = "new" | "open" | "saveAs" | "refresh";

interface QueueToolbarProps {
  snapshot?: QueueSnapshot;
  fileAction?: FileAction;
  isRunning: boolean;
  onNewQueue: () => void;
  onOpenQueue: () => void;
  onSaveAs: () => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
  onRun: () => void;
  onNewTask: () => void;
}

export function QueueToolbar({
  snapshot,
  fileAction,
  isRunning,
  onNewQueue,
  onOpenQueue,
  onSaveAs,
  onRefresh,
  onOpenSettings,
  onRun,
  onNewTask,
}: QueueToolbarProps) {
  const { t } = useTranslation();
  const fileBusy = fileAction !== undefined;

  return (
    <header className="flex flex-col gap-4 border-b pb-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-foreground text-background">
          <ListChecksIcon aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-base font-semibold">{t("app.name")}</h1>
            {snapshot && (
              <span className="text-xs text-muted-foreground">
                {t("queue.taskCount", { count: snapshot.queue.tasks.length })}
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {snapshot?.path ?? t("queue.noPath")}
          </p>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <ToolbarIconButton
          label={t("queue.new")}
          icon={FilePlus2Icon}
          busy={fileAction === "new"}
          disabled={fileBusy || isRunning}
          onClick={onNewQueue}
        />
        <ToolbarIconButton
          label={t("queue.open")}
          icon={FolderOpenIcon}
          busy={fileAction === "open"}
          disabled={fileBusy || isRunning}
          onClick={onOpenQueue}
        />
        <ToolbarIconButton
          label={t("queue.saveAs")}
          icon={SaveIcon}
          busy={fileAction === "saveAs"}
          disabled={!snapshot || fileBusy || isRunning}
          onClick={onSaveAs}
        />
        <ToolbarIconButton
          label={t("queue.refresh")}
          icon={RefreshCwIcon}
          busy={fileAction === "refresh"}
          disabled={!snapshot || fileBusy}
          onClick={onRefresh}
        />
        <ToolbarIconButton
          label={t("queue.settings")}
          icon={Settings2Icon}
          disabled={!snapshot || isRunning}
          onClick={onOpenSettings}
        />

        <Separator orientation="vertical" className="mx-0.5 h-5" />
        <LanguageMenu />
        <ThemeMenu />
        <Separator orientation="vertical" className="mx-0.5 h-5" />

        <Button onClick={onRun} disabled={!snapshot || isRunning || fileBusy}>
          {isRunning ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <PlayIcon data-icon="inline-start" />
          )}
          {t(isRunning ? "queue.running" : "queue.run")}
        </Button>
        <Button
          variant="create"
          onClick={onNewTask}
          disabled={!snapshot || isRunning}
        >
          <PlusIcon data-icon="inline-start" />
          {t("task.new")}
        </Button>
      </div>
    </header>
  );
}

function ToolbarIconButton({
  label,
  icon: Icon,
  busy = false,
  disabled = false,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          >
            {busy ? <Spinner /> : <Icon aria-hidden />}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function LanguageMenu() {
  const { t, i18n } = useTranslation();
  const locale = normalizeLocale(i18n.resolvedLanguage ?? i18n.language);

  async function changeLanguage(value: string) {
    await i18n.changeLanguage(value as AppLocale);
    toast.success(i18n.t("toast.languageChanged"));
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("accessibility.changeLanguage")}
              >
                <LanguagesIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("toolbar.language")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("toolbar.language")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={locale}
            onValueChange={(value) => void changeLanguage(value)}
          >
            <DropdownMenuRadioItem value="zh-CN">
              {t("languages.zhCN")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="en">
              {t("languages.en")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeMenu() {
  const { t } = useTranslation();
  const { theme = "system", resolvedTheme, setTheme } = useTheme();
  const ThemeIcon =
    theme === "system"
      ? MonitorIcon
      : resolvedTheme === "dark"
        ? MoonIcon
        : SunIcon;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("accessibility.changeTheme")}
              >
                <ThemeIcon aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("toolbar.theme")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("toolbar.theme")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
            <DropdownMenuRadioItem value="light">
              <SunIcon aria-hidden="true" />
              {t("common.light")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <MoonIcon aria-hidden="true" />
              {t("common.dark")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
              <MonitorIcon aria-hidden="true" />
              {t("common.system")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
