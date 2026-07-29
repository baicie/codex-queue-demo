import { cn } from "@/lib/utils";
import { Loader2Icon } from "lucide-react";

function Spinner({
  className,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role={ariaLabel ? "status" : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
