import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "@heroui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { App } from "./App";
import { queryClient } from "./lib/queryClient";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark">
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <App />
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
