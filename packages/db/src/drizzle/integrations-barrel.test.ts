import { describe, expect, it } from "vitest";
import { drizzle } from "../index";

describe("drizzle barrel — integrations", () => {
  it("exposes integrationConnectionRepo and integrationDeliveryRepo", () => {
    expect(typeof drizzle.integrationConnectionRepo.createConnection).toBe("function");
    expect(typeof drizzle.integrationDeliveryRepo.insertPendingDelivery).toBe("function");
  });
});
