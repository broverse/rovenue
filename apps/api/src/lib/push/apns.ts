// =============================================================
// APNs HTTP/2 transport (token-based auth)
// =============================================================
//
// Sends `aps` payloads to api.push.apple.com (or
// api.sandbox.push.apple.com for the TestFlight gateway) using
// a JWT signed with the team's .p8 key. Apple requires the JWT
// to be renewed at least every hour; we cache it for 50min to
// give a 10min safety margin.
//
// The actual HTTP/2 round-trip is delegated to an injected
// `sender` function so unit tests can stub the network. The
// default sender (`createApnsHttp2Sender`) opens one long-lived
// `node:http2` session per host and reuses it across sends.
//
// Response classification:
//   - 200            → ok, providerMessageId = apns-id header
//   - 400 BadDeviceToken / Unregistered / DeviceTokenNotForTopic → permanent
//   - 410 Gone       → permanent (token unregistered upstream)
//   - 4xx / 5xx else → transient (BullMQ retries with backoff)

import { connect, type ClientHttp2Session } from "node:http2";
import { importPKCS8, SignJWT } from "jose";
import type {
  PushMessage,
  PushSendOutcome,
  PushTransport,
} from "./transport";

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** Contents of the AuthKey_*.p8 file (BEGIN/END lines included). */
  keyP8: string;
  bundleId: string;
  environment: "production" | "sandbox";
}

export interface ApnsHttp2Request {
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface ApnsHttp2Response {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export type ApnsHttp2Send = (
  req: ApnsHttp2Request,
) => Promise<ApnsHttp2Response>;

const HOST_PROD = "https://api.push.apple.com";
const HOST_SANDBOX = "https://api.sandbox.push.apple.com";

const PERMANENT_400_REASONS = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
]);

const JWT_TTL_MS = 50 * 60 * 1000;

interface JwtCache {
  token: string;
  expiresAt: number;
}

export class ApnsPushTransport implements PushTransport {
  readonly platform = "ios" as const;
  private jwtCache: JwtCache | null = null;

  constructor(
    private readonly config: ApnsConfig,
    private readonly sender: ApnsHttp2Send = createApnsHttp2Sender(
      config.environment,
    ),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async send(message: PushMessage): Promise<PushSendOutcome> {
    const jwt = await this.getJwt();
    const payload = {
      aps: {
        alert: { title: message.title, body: message.body },
        ...(message.threadId ? { "thread-id": message.threadId } : {}),
        ...(typeof message.badge === "number" ? { badge: message.badge } : {}),
        "mutable-content": 1,
      },
      data: message.data,
    };
    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      "apns-topic": this.config.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    };
    if (message.collapseKey) headers["apns-collapse-id"] = message.collapseKey;

    let res: ApnsHttp2Response;
    try {
      res = await this.sender({
        path: `/3/device/${message.deviceToken}`,
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "apns_network_error",
        permanent: false,
        raw: err,
      };
    }

    return classifyApnsResponse(res);
  }

  private async getJwt(): Promise<string> {
    if (this.jwtCache && this.jwtCache.expiresAt > this.now()) {
      return this.jwtCache.token;
    }
    const key = await importPKCS8(this.config.keyP8, "ES256");
    const issuedAt = Math.floor(this.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: this.config.keyId })
      .setIssuer(this.config.teamId)
      .setIssuedAt(issuedAt)
      .sign(key);
    this.jwtCache = { token, expiresAt: this.now() + JWT_TTL_MS };
    return token;
  }
}

export function classifyApnsResponse(
  res: ApnsHttp2Response,
): PushSendOutcome {
  if (res.statusCode === 200) {
    const apnsId = res.headers["apns-id"];
    const providerMessageId = Array.isArray(apnsId) ? apnsId[0] : apnsId;
    return { ok: true, providerMessageId: providerMessageId ?? "" };
  }

  let reason: string | undefined;
  try {
    reason = res.body
      ? (JSON.parse(res.body) as { reason?: string }).reason
      : undefined;
  } catch {
    reason = undefined;
  }

  if (res.statusCode === 410) {
    return {
      ok: false,
      error: reason ?? "Unregistered",
      permanent: true,
      raw: res,
    };
  }
  if (
    res.statusCode === 400 &&
    reason &&
    PERMANENT_400_REASONS.has(reason)
  ) {
    return { ok: false, error: reason, permanent: true, raw: res };
  }

  return {
    ok: false,
    error: reason ?? `apns_http_${res.statusCode}`,
    permanent: false,
    raw: res,
  };
}

export function createApnsHttp2Sender(
  environment: "production" | "sandbox",
): ApnsHttp2Send {
  const origin = environment === "sandbox" ? HOST_SANDBOX : HOST_PROD;
  let session: ClientHttp2Session | null = null;

  function open(): ClientHttp2Session {
    if (session && !session.destroyed && !session.closed) return session;
    session = connect(origin);
    session.on("error", () => {
      session?.destroy();
      session = null;
    });
    return session;
  }

  return ({ path, headers, body }) =>
    new Promise<ApnsHttp2Response>((resolve, reject) => {
      const s = open();
      const req = s.request({
        ":method": "POST",
        ":path": path,
        ...headers,
      });
      const chunks: Buffer[] = [];
      let statusCode = 0;
      const responseHeaders: Record<string, string | string[] | undefined> = {};

      req.setEncoding("utf8");
      req.on("response", (h) => {
        const status = h[":status"];
        statusCode = typeof status === "number" ? status : 0;
        for (const [k, v] of Object.entries(h)) {
          if (k === ":status") continue;
          responseHeaders[k] = v as string | string[] | undefined;
        }
      });
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("error", reject);
      req.on("end", () => {
        resolve({
          statusCode,
          headers: responseHeaders,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });

      req.write(body);
      req.end();
    });
}
