import type { Db } from "../client";

// Stub surface for Task 4.4. Phase 5 (Task 5.3) replaces these with
// real implementations once the project_invitations table lands.

export interface InvitationEmailLoad {
  invitation: {
    id: string;
    email: string;
    role: string;
    expiresAt: Date;
  };
  inviterName: string;
  projectName: string;
}

export async function findInvitationForEmailSend(
  _db: Db,
  _id: string,
): Promise<InvitationEmailLoad | null> {
  throw new Error("invitationRepo.findInvitationForEmailSend not implemented yet — see Phase 5");
}

export async function patchSendResult(
  _db: Db,
  _id: string,
  _patch: { sesMessageId: string; lastSentAt: Date },
): Promise<void> {
  throw new Error("invitationRepo.patchSendResult not implemented yet — see Phase 5");
}
