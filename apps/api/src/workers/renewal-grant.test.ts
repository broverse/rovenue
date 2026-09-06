import { beforeEach, describe, expect, test, vi } from "vitest";
import { runRenewalGrant } from "./renewal-grant";
import type { RenewalGrantJob } from "../queues/renewal-grants";

const job: RenewalGrantJob = {
  revenueEventId: "rev_1",
  projectId: "prj_1",
  subscriberId: "sub_1",
  productId: "prd_1",
  type: "RENEWAL",
};

let grant: ReturnType<typeof vi.fn>;
let loadProduct: ReturnType<typeof vi.fn>;

beforeEach(() => {
  grant = vi.fn(async () => {});
  loadProduct = vi.fn(async (_projectId: string, _productId: string) => ({
    identifier: "pro_monthly",
  }));
});

describe("runRenewalGrant", () => {
  test("grants with the RENEWAL trigger keyed on the revenue event id", async () => {
    const result = await runRenewalGrant(job, { grant, loadProduct });

    expect(result).toBe("granted");
    expect(grant).toHaveBeenCalledWith({
      subscriberId: "sub_1",
      productId: "prd_1",
      referenceId: "rev_1",
      productIdentifier: "pro_monthly",
      trigger: "RENEWAL",
    });
  });

  test("skips an event type that is not a granting type", async () => {
    const result = await runRenewalGrant(
      { ...job, type: "INITIAL" },
      { grant, loadProduct },
    );

    // INITIAL is the PURCHASE trigger's event. If it also granted here, a
    // BOTH row would grant twice on day one.
    expect(result).toBe("skipped");
    expect(grant).not.toHaveBeenCalled();
  });

  test.each(["RENEWAL", "TRIAL_CONVERSION", "REACTIVATION"])(
    "%s is a granting type",
    async (type) => {
      const result = await runRenewalGrant({ ...job, type }, { grant, loadProduct });
      expect(result).toBe("granted");
    },
  );

  test.each(["INITIAL", "REFUND", "CANCELLATION", "CREDIT_PURCHASE"])(
    "%s is not a granting type",
    async (type) => {
      const result = await runRenewalGrant({ ...job, type }, { grant, loadProduct });
      expect(result).toBe("skipped");
    },
  );

  test("skips when the product no longer exists", async () => {
    loadProduct.mockResolvedValue(null);

    const result = await runRenewalGrant(job, { grant, loadProduct });

    expect(result).toBe("skipped");
    expect(grant).not.toHaveBeenCalled();
  });

  test("propagates a grant failure so BullMQ retries it", async () => {
    grant.mockRejectedValue(new Error("db down"));

    // This is the property that separates this worker from the
    // integrations fanout consumer, which logs and swallows. A swallowed
    // error here would lose a subscriber's credits permanently.
    await expect(runRenewalGrant(job, { grant, loadProduct })).rejects.toThrow(
      "db down",
    );
  });
});
