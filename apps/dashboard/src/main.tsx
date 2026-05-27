import "reflect-metadata";
import "./lib/impair-config";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "@heroui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { router } from "./router";
import { queryClient } from "./lib/queryClient";
import "./i18n/config";
import "./index.css";

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// React.StrictMode's dev-only double-mount disposes impair containers
// mid-fetch and the cached useService instance survives in `disposed`
// state — the funnel builder gets stuck on "loading…". Disable StrictMode
// until impair gains StrictMode-safe re-resolve on dispose.
ReactDOM.createRoot(document.getElementById("root")!).render(
  <ThemeProvider
    attribute="class"
    defaultTheme="system"
    enableSystem
    disableTransitionOnChange
  >
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </I18nProvider>
  </ThemeProvider>,
);
