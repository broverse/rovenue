import { request } from "undici";
import type { HttpClient } from "./types";

/** Delivery response bodies are stored (audit log, test-event echo) truncated
 *  to this many bytes — provider responses can be arbitrarily large. */
export const RESPONSE_BODY_MAX_BYTES = 4096;

export function createUndiciHttpClient(): HttpClient {
  return {
    async request(input) {
      const res = await request(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.body,
      });
      const text = await res.body.text();
      return { status: res.statusCode, body: text };
    },
  };
}
