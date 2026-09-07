// =============================================================
// Container pass: fail loudly when the Docker daemon is not there
// =============================================================
//
// `packages/db`'s `test` script is two sequential vitest runs, the second
// of which (VITEST_CONTAINER_PASS=1) is nothing but
// `tests/partman-registration.integration.test.ts` — the only end-to-end
// proof migration 0130 has. That file builds an image and starts two
// containers, so it needs a live daemon.
//
// This repo's standing footgun is that vitest does NOT fail fast when the
// daemon is down: testcontainers retries the socket and the run HANGS,
// with no output that names Docker. A developer without Docker running
// gets a wedged terminal, not a red build.
//
// So the container pass runs this globalSetup first. It THROWS — it never
// skips. A skip here would silently convert 0130's only real proof into a
// permanent green, which is precisely the defect class this whole batch
// exists to remove; vitest treats a globalSetup throw as a failed run and
// exits non-zero, and `package.json`'s `&&` propagates that.
//
// WHY THE PROBE IS DELIBERATELY GENEROUS
//
// A guard that goes red on a healthy machine is its own kind of damage, so
// this tries every endpoint testcontainers itself would try — DOCKER_HOST
// when set, otherwise the standard socket locations — and, only if all of
// them fail, falls back to `docker version`, which picks up a non-default
// docker context that no socket path would reveal. The failure direction
// is one-way: any single success is enough to proceed, and only a total
// failure throws.

import { execFile } from "node:child_process";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

/** Docker's liveness endpoint. Returns 200 with the body "OK". */
const PING_PATH = "/_ping";
const PING_OK_STATUS = 200;
/** Long enough for a busy daemon to answer, short enough that a dead
 *  socket is reported in seconds rather than hanging the run. */
const PROBE_TIMEOUT_MS = 5_000;
const CLI_FALLBACK_TIMEOUT_MS = 10_000;

/** Where the daemon listens when DOCKER_HOST says nothing. Ordered by how
 *  common they are: the standard socket, Docker Desktop's per-user socket,
 *  Colima, Rancher Desktop. */
const DEFAULT_SOCKET_PATHS: readonly string[] = [
  "/var/run/docker.sock",
  join(homedir(), ".docker", "run", "docker.sock"),
  join(homedir(), ".colima", "default", "docker.sock"),
  join(homedir(), ".rd", "docker.sock"),
];

const DOCKER_CLI = "docker";
const DOCKER_CLI_ARGS = ["version", "--format", "{{.Server.Version}}"];

const UNIX_SCHEME = "unix://";
const TCP_SCHEMES: readonly string[] = ["tcp://", "http://", "https://"];
const DEFAULT_TCP_PORT = 2375;

type Endpoint =
  | { kind: "socket"; socketPath: string; label: string }
  | { kind: "tcp"; host: string; port: number; label: string };

function parseDockerHost(dockerHost: string): Endpoint | undefined {
  if (dockerHost.startsWith(UNIX_SCHEME)) {
    const socketPath = dockerHost.slice(UNIX_SCHEME.length);
    return { kind: "socket", socketPath, label: dockerHost };
  }
  const scheme = TCP_SCHEMES.find((s) => dockerHost.startsWith(s));
  if (scheme === undefined) return undefined;
  const rest = dockerHost.slice(scheme.length);
  const [host, port] = rest.split(":");
  if (host === undefined || host.length === 0) return undefined;
  return {
    kind: "tcp",
    host,
    port: port === undefined ? DEFAULT_TCP_PORT : Number(port),
    label: dockerHost,
  };
}

function candidateEndpoints(): Endpoint[] {
  // When DOCKER_HOST is set it is the ONLY thing testcontainers will use,
  // so probing the default sockets as well would let this guard pass while
  // the suite itself still fails. Honour the override exactly.
  const dockerHost = process.env.DOCKER_HOST?.trim();
  if (dockerHost !== undefined && dockerHost.length > 0) {
    const parsed = parseDockerHost(dockerHost);
    return parsed === undefined ? [] : [parsed];
  }
  return DEFAULT_SOCKET_PATHS.map((socketPath) => ({
    kind: "socket" as const,
    socketPath,
    label: socketPath,
  }));
}

function ping(endpoint: Endpoint): Promise<boolean> {
  return new Promise((resolve) => {
    const options =
      endpoint.kind === "socket"
        ? { socketPath: endpoint.socketPath, path: PING_PATH }
        : { host: endpoint.host, port: endpoint.port, path: PING_PATH };
    const req = request(
      { ...options, method: "GET", timeout: PROBE_TIMEOUT_MS },
      (res) => {
        res.resume();
        resolve(res.statusCode === PING_OK_STATUS);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** Last resort: the CLI resolves docker contexts, which no fixed socket
 *  path can. Only reached when every endpoint probe already failed. */
function dockerCliReportsAServer(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      DOCKER_CLI,
      DOCKER_CLI_ARGS,
      { timeout: CLI_FALLBACK_TIMEOUT_MS },
      (error, stdout) => {
        resolve(error === null && stdout.trim().length > 0);
      },
    );
  });
}

export async function setup(): Promise<void> {
  const endpoints = candidateEndpoints();
  for (const endpoint of endpoints) {
    if (await ping(endpoint)) return;
  }
  if (await dockerCliReportsAServer()) return;

  const tried =
    endpoints.length === 0
      ? `DOCKER_HOST="${process.env.DOCKER_HOST ?? ""}" (unrecognised scheme)`
      : endpoints.map((e) => e.label).join(", ");
  throw new Error(
    [
      "Docker daemon unreachable — the @rovenue/db container pass cannot run.",
      "",
      "This pass is a single suite, tests/partman-registration.integration.test.ts,",
      "and it is the only end-to-end proof of migration 0130 (pg_partman",
      "registration for revenue_events / credit_ledger). It builds the",
      "deploy/postgres image and starts two Postgres containers.",
      "",
      `Tried: ${tried}`,
      `Then: \`${DOCKER_CLI} ${DOCKER_CLI_ARGS.join(" ")}\` — also failed.`,
      "",
      "Start Docker and re-run `pnpm --filter @rovenue/db test`. If your daemon",
      "is reachable some other way, export DOCKER_HOST so testcontainers and",
      "this check agree on where it is.",
      "",
      "This check throws rather than skipping on purpose: a skip would turn",
      "migration 0130's only real proof into a permanent green.",
    ].join("\n"),
  );
}
