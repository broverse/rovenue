import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setMailerForTests, type Mailer } from "../lib/mailer";
import { runInvitationEmailJob } from "./email";
import { drizzle } from "@rovenue/db";

class RecordingMailer implements Mailer {
  readonly provider = "test";
  sent: Array<{ to: string; subject: string; correlationId?: string }> = [];
  async send(m: { to: string; subject: string; html: string; text: string; correlationId?: string }) {
    this.sent.push({ to: m.to, subject: m.subject, correlationId: m.correlationId });
    return { messageId: `mock-${this.sent.length}` };
  }
}

describe("runInvitationEmailJob", () => {
  beforeEach(() => __setMailerForTests(null));
  afterEach(() => {
    vi.restoreAllMocks();
    __setMailerForTests(null);
  });

  it("no-ops when invitation is no longer pending", async () => {
    const rec = new RecordingMailer();
    __setMailerForTests(rec);
    vi.spyOn(drizzle.invitationRepo, "findInvitationForEmailSend").mockResolvedValueOnce(null);

    const out = await runInvitationEmailJob({
      invitationId: "inv_404",
      inviteUrl: "https://dash.test/invitations/rov_inv_skip",
    });
    expect(out).toEqual({ skipped: "not_pending" });
    expect(rec.sent).toHaveLength(0);
  });

  function mockLoad() {
    vi.spyOn(drizzle.invitationRepo, "findInvitationForEmailSend").mockResolvedValueOnce({
      invitation: {
        id: "inv_1",
        email: "a@b.com",
        role: "DEVELOPER",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
      projectId: "proj_1",
      inviterName: "Furkan",
      projectName: "Rovenue",
    });
  }

  it("sends via mailer and patches sesMessageId + lastSentAt on success", async () => {
    const rec = new RecordingMailer();
    __setMailerForTests(rec);
    mockLoad();
    const claim = vi.spyOn(drizzle.invitationRepo, "claimInvitationForSend").mockResolvedValueOnce(true);
    const patch = vi.spyOn(drizzle.invitationRepo, "patchSendResult").mockResolvedValueOnce(undefined as unknown as void);

    const out = await runInvitationEmailJob({
      invitationId: "inv_1",
      inviteUrl: "https://dash.test/invitations/rov_inv_abc",
    });

    expect(out).toEqual({ sent: true, messageId: "mock-1" });
    expect(rec.sent[0].to).toBe("a@b.com");
    expect(rec.sent[0].correlationId).toBe("inv_1");
    expect(claim).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledTimes(1);
    const call = patch.mock.calls[0];
    expect(call[1]).toBe("inv_1");
    expect(call[2].sesMessageId).toBe("mock-1");
    expect(call[2].lastSentAt).toBeInstanceOf(Date);
  });

  it("skips (no email) when another in-flight send holds the claim", async () => {
    // The double-send window this closes: process killed between provider
    // send and patchSendResult, then BullMQ stall-redelivers the job — or
    // two duplicate jobs race. The second runner must not email again.
    const rec = new RecordingMailer();
    __setMailerForTests(rec);
    mockLoad();
    vi.spyOn(drizzle.invitationRepo, "claimInvitationForSend").mockResolvedValueOnce(false);

    const out = await runInvitationEmailJob({
      invitationId: "inv_1",
      inviteUrl: "https://dash.test/invitations/rov_inv_abc",
    });

    expect(out).toEqual({ skipped: "claimed_by_inflight_send" });
    expect(rec.sent).toHaveLength(0);
  });

  it("releases the claim and rethrows when the provider send fails", async () => {
    class FailingMailer implements Mailer {
      readonly provider = "test";
      async send(): Promise<{ messageId: string }> {
        throw new Error("smtp down");
      }
    }
    __setMailerForTests(new FailingMailer());
    mockLoad();
    vi.spyOn(drizzle.invitationRepo, "claimInvitationForSend").mockResolvedValueOnce(true);
    const release = vi
      .spyOn(drizzle.invitationRepo, "releaseInvitationSendClaim")
      .mockResolvedValueOnce(undefined as unknown as void);
    const patch = vi.spyOn(drizzle.invitationRepo, "patchSendResult");

    await expect(
      runInvitationEmailJob({
        invitationId: "inv_1",
        inviteUrl: "https://dash.test/invitations/rov_inv_abc",
      }),
    ).rejects.toThrow("smtp down");

    expect(release).toHaveBeenCalledWith(expect.anything(), "inv_1");
    expect(patch).not.toHaveBeenCalled();
  });
});
