import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { AppSwitcher } from "../../src/components/dashboard/app-switcher";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return { ...actual, useNavigate: () => navigateSpy };
});

vi.mock("../../src/lib/hooks/useProjects", () => ({
  useProjects: () => ({
    data: [
      { id: "p1", name: "Alpha", slug: "alpha" },
      { id: "p2", name: "Beta", slug: "beta" },
    ],
  }),
}));

beforeEach(async () => {
  navigateSpy.mockReset();
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: "en",
      resources: {
        en: {
          translation: {
            appSwitcher: {
              switchProject: "Switch project",
              projects: "Projects",
              newProject: "New project",
            },
            common: { current: "current" },
          },
        },
      },
    });
  }
});

function renderSwitcher() {
  const client = new QueryClient();
  return render(
    <I18nextProvider i18n={i18next}>
      <QueryClientProvider client={client}>
        <AppSwitcher projectId="p1" projectName="Alpha" />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("AppSwitcher", () => {
  it("offers a + New project entry that navigates to /projects/setup", async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByTitle("Switch project"));
    const newItem = await screen.findByText("New project");
    await user.click(newItem);
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/projects/setup" });
  });
});
