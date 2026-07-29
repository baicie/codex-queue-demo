import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "@/App";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/index.css";
import { AppProviders } from "@/providers/app-providers";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProviders>
      <TooltipProvider>
        <App />
        <Toaster position="bottom-right" richColors />
      </TooltipProvider>
    </AppProviders>
  </StrictMode>,
);
