import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FONT_FACES_MAX_PER_PROJECT } from "@rovenue/shared";
import "../../../../../i18n/config";
import { server } from "../../../../../../tests/msw/server";
import { renderWithRouter } from "../../../../../../tests/render";
import { FontsPage } from "./fonts";
import type { FontFamily } from "../../../../../lib/hooks/useFonts";

// =============================================================
// Task 6 — the dashboard Fonts screen
// =============================================================
//
// Pins the three behaviors from the task brief: the family/face
// list renders what the GET endpoint returns, the face count shown
// is driven by the imported FONT_FACES_MAX_PER_PROJECT (never a
// hard-coded number), and — the one that matters most, design spec
// §4.1 — deleting a font family states its consequence (paywalls
// referencing it fall back to the system font) up front in the
// confirmation, not after the fact.
//
// Only the GET/DELETE dashboard fonts endpoints are mocked via MSW;
// FontsPage is rendered directly (not through the file-route's own
// `useParams`), matching the `charts.test.tsx` idiom next door.

const BASE = "http://localhost:3000";
const PROJECT_ID = "proj_1";

function renderFontsPage({ families }: { families: FontFamily[] }) {
  server.use(
    http.get(`${BASE}/dashboard/projects/${PROJECT_ID}/fonts`, () =>
      HttpResponse.json({ data: families }),
    ),
    http.delete(
      `${BASE}/dashboard/projects/${PROJECT_ID}/fonts/:familyId`,
      () => HttpResponse.json({ data: { deleted: true } }),
    ),
  );
  return renderWithRouter(
    <FontsPage projectId={PROJECT_ID} />,
    `/projects/${PROJECT_ID}/settings/fonts`,
  );
}

describe("FontsPage", () => {
  it("lists a family with its faces", async () => {
    renderFontsPage({
      families: [
        {
          id: "f1",
          name: "Brand Sans",
          faces: [
            { id: "a", weight: 400, style: "normal", format: "otf", byteSize: 1024 },
          ],
        },
      ],
    });
    expect(await screen.findByText("Brand Sans")).toBeInTheDocument();
    expect(screen.getByText(/400/)).toBeInTheDocument();
  });

  it("shows the face count against the cap", async () => {
    renderFontsPage({ families: [] });
    expect(
      await screen.findByText(new RegExp(`0\\s*/\\s*${FONT_FACES_MAX_PER_PROJECT}`)),
    ).toBeInTheDocument();
  });

  it("warns that deleting a font in use falls back to the system font", async () => {
    renderFontsPage({ families: [{ id: "f1", name: "Brand Sans", faces: [] }] });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /delete/i }));
    expect(screen.getByText(/system font/i)).toBeInTheDocument();
  });
});
