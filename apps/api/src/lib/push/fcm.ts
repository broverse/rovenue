// =============================================================
// FCM v1 HTTP API transport
// =============================================================
//
// Sends Android push via fcm.googleapis.com/v1/projects/<id>/messages:send
// using an OAuth2 access token minted from the service-account JSON
// (google-auth-library handles refresh internally — we wrap it in an
// injectable provider for unit tests).
//
// Token provider + HTTP sender are injectable so unit tests can
// stub the network without mocking modules. The defaults match the
// production behaviour: `google-auth-library` JWT client for
// tokens, native `fetch` for the POST.
//
// Response classification (FCM v1 error shape):
//   200            → ok (`name: projects/.../messages/<id>` is the providerMessageId)
//   404, or errorCode UNREGISTERED / SENDER_ID_MISMATCH / INVALID_ARGUMENT → permanent
//   anything else                                                          → transient

import { JWT } from "google-auth-library";
import type {
  PushMessage,
  PushSendOutcome,
  PushTransport,
} from "./transport";

export interface FcmConfig {
  /** Verbatim service-account JSON (parsed lazily). */
  serviceAccountJson: string;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

export type FcmAccessTokenProvider = () => Promise<string>;

export interface FcmHttpRequest {
  url: string;
  body: string;
  accessToken: string;
}

export interface FcmHttpResponse {
  statusCode: number;
  body: string;
}

export type FcmHttpSend = (req: FcmHttpRequest) => Promise<FcmHttpResponse>;

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

const PERMANENT_ERROR_CODES = new Set([
  "UNREGISTERED",
  "SENDER_ID_MISMATCH",
  "INVALID_ARGUMENT",
]);

export class FcmPushTransport implements PushTransport {
  readonly platform = "android" as const;
  private readonly account: ServiceAccount;
  private readonly endpoint: string;

  constructor(
    config: FcmConfig,
    private readonly tokenProvider: FcmAccessTokenProvider = defaultTokenProvider(
      config.serviceAccountJson,
    ),
    private readonly sender: FcmHttpSend = defaultFcmSender,
  ) {
    this.account = parseServiceAccount(config.serviceAccountJson);
    this.endpoint = `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`;
  }

  async send(message: PushMessage): Promise<PushSendOutcome> {
    let accessToken: string;
    try {
      accessToken = await this.tokenProvider();
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "fcm_token_error",
        permanent: false,
        raw: err,
      };
    }

    const payload = {
      message: {
        token: message.deviceToken,
        notification: { title: message.title, body: message.body },
        data: message.data,
        ...(message.collapseKey
          ? { android: { collapse_key: message.collapseKey } }
          : {}),
      },
    };

    let res: FcmHttpResponse;
    try {
      res = await this.sender({
        url: this.endpoint,
        body: JSON.stringify(payload),
        accessToken,
      });
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "fcm_network_error",
        permanent: false,
        raw: err,
      };
    }

    return classifyFcmResponse(res);
  }
}

export function classifyFcmResponse(res: FcmHttpResponse): PushSendOutcome {
  if (res.statusCode === 200) {
    try {
      const parsed = JSON.parse(res.body) as { name?: string };
      return { ok: true, providerMessageId: parsed.name ?? "" };
    } catch {
      return { ok: true, providerMessageId: "" };
    }
  }

  const errorCode = extractFcmErrorCode(res.body);

  if (
    res.statusCode === 404 ||
    (errorCode && PERMANENT_ERROR_CODES.has(errorCode))
  ) {
    return {
      ok: false,
      error: errorCode ?? `fcm_http_${res.statusCode}`,
      permanent: true,
      raw: res,
    };
  }

  return {
    ok: false,
    error: errorCode ?? `fcm_http_${res.statusCode}`,
    permanent: false,
    raw: res,
  };
}

function extractFcmErrorCode(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        status?: string;
        details?: Array<{ "@type"?: string; errorCode?: string }>;
      };
    };
    const detail = parsed.error?.details?.find(
      (d) => typeof d.errorCode === "string",
    );
    return detail?.errorCode ?? parsed.error?.status;
  } catch {
    return undefined;
  }
}

function parseServiceAccount(json: string): ServiceAccount {
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(json) as ServiceAccount;
  } catch (err) {
    throw new Error(
      `FCM_SERVICE_ACCOUNT_JSON is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error(
      "FCM_SERVICE_ACCOUNT_JSON missing project_id / client_email / private_key",
    );
  }
  return parsed;
}

function defaultTokenProvider(json: string): FcmAccessTokenProvider {
  let client: JWT | null = null;
  return async () => {
    if (!client) {
      const account = parseServiceAccount(json);
      client = new JWT({
        email: account.client_email,
        key: account.private_key,
        scopes: [FCM_SCOPE],
      });
    }
    const { token } = await client.getAccessToken();
    if (!token) throw new Error("FCM: getAccessToken returned no token");
    return token;
  };
}

const defaultFcmSender: FcmHttpSend = async ({ url, body, accessToken }) => {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body,
  });
  return { statusCode: res.status, body: await res.text() };
};
