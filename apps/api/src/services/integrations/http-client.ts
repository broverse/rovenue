import { request } from "undici";
import type { HttpClient } from "./types";

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
