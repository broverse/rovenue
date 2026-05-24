import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { SetupTopbar } from "../../src/components/project-setup/setup-topbar";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

beforeEach(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: "en",
      resources: {
        en: {
          translation: {
            topNav: { appName: "Rovenue" },
            projectSetup: {
              crumb: { workspace: "Workspace", projects: "Projects", newProject: "New project" },
              close: "Close",
              cancel: "Cancel",
              mode: { create: "Create", update: "Update" },
            },
          },
        },
      },
    });
  }
});

describe("SetupTopbar Cancel affordance", () => {
  it("renders a Cancel control when onCancel is provided", async () => {
    const onCancel = vi.fn();
    render(
      <I18nextProvider i18n={i18next}>
        <SetupTopbar mode="create" projectName={null} onCancel={onCancel} />
      </I18nextProvider>,
    );
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    await userEvent.setup().click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("hides the Cancel control when onCancel is omitted", () => {
    render(
      <I18nextProvider i18n={i18next}>
        <SetupTopbar mode="create" projectName={null} />
      </I18nextProvider>,
    );
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });
});
