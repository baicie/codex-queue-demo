import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { QueueApp } from "@/features/queue/queue-app";
import { SupervisorDashboard } from "@/features/supervisor/supervisor-dashboard";
import { cn } from "@/lib/utils";
import {
  ActivityIcon,
  LanguagesIcon,
  ListChecksIcon,
  MoonIcon,
  SunIcon,
  WaypointsIcon,
  type LucideIcon,
} from "lucide-react";

type WorkspaceView = "supervisor" | "queue";

export function SupervisorWorkspace() {
  const { t, i18n } = useTranslation();
  const { resolvedTheme, setTheme } = useTheme();
  const [view, setView] = useState<WorkspaceView>("supervisor");

  function toggleLanguage() {
    void i18n.changeLanguage(i18n.resolvedLanguage === "en" ? "zh-CN" : "en");
  }

  function toggleTheme() {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r bg-card md:flex">
        <div className="flex h-16 items-center gap-2.5 border-b px-4">
          <div className="flex size-8 items-center justify-center rounded-md bg-foreground text-background">
            <WaypointsIcon className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">Codex Queue</p>
            <p className="truncate text-xs text-muted-foreground">
              {t("supervisor.shell.localRuntime")}
            </p>
          </div>
        </div>

        <nav
          className="flex flex-1 flex-col gap-1 p-3"
          aria-label={t("accessibility.mainNavigation")}
        >
          <NavigationItem
            active={view === "supervisor"}
            icon={ActivityIcon}
            label={t("navigation.supervisor")}
            onClick={() => setView("supervisor")}
          />
          <NavigationItem
            active={view === "queue"}
            icon={ListChecksIcon}
            label={t("navigation.queue")}
            onClick={() => setView("queue")}
          />
        </nav>

        <div className="flex items-center gap-1 border-t p-3">
          <UtilityButton
            label={t("accessibility.changeLanguage")}
            icon={LanguagesIcon}
            onClick={toggleLanguage}
          />
          <UtilityButton
            label={t("accessibility.changeTheme")}
            icon={resolvedTheme === "dark" ? SunIcon : MoonIcon}
            onClick={toggleTheme}
          />
          <span className="ml-auto text-[11px] text-muted-foreground">
            v0.3.0-dev.2
          </span>
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b bg-background/95 px-3 backdrop-blur md:hidden">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-foreground text-background">
            <WaypointsIcon className="size-3.5" aria-hidden="true" />
          </div>
          <span className="text-sm font-semibold">Codex Queue</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant={view === "supervisor" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={t("navigation.supervisor")}
            onClick={() => setView("supervisor")}
          >
            <ActivityIcon />
          </Button>
          <Button
            variant={view === "queue" ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={t("navigation.queue")}
            onClick={() => setView("queue")}
          >
            <ListChecksIcon />
          </Button>
          <UtilityButton
            label={t("accessibility.changeTheme")}
            icon={resolvedTheme === "dark" ? SunIcon : MoonIcon}
            onClick={toggleTheme}
          />
        </div>
      </header>

      <div className="md:pl-56">
        {view === "supervisor" ? (
          <SupervisorDashboard onOpenQueue={() => setView("queue")} />
        ) : (
          <QueueApp />
        )}
      </div>
    </div>
  );
}

function NavigationItem({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-sm font-medium transition-colors",
        active
          ? "bg-foreground text-background"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <Icon className="size-4" aria-hidden="true" />
      {label}
    </button>
  );
}

function UtilityButton({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
        >
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
