import { describe, expect, it } from "vitest";
import { bootIntegrations } from "./integrations-boot";

describe("bootIntegrations", () => {
  it("returns a controller with stop()", async () => {
    const handle = await bootIntegrations({ autoStart: false });
    expect(typeof handle.stop).toBe("function");
    await handle.stop();
  });
});
