import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setup } from "./docker-daemon-guard";

// =============================================================
// Docker liveness guard — can it still fire, and can it still pass?
// =============================================================
//
// `docker-daemon-guard.ts` is the globalSetup for this package's container
// pass. It exists to convert "vitest hangs because the daemon is down" into
// a named, non-zero failure, which makes it exactly the kind of thing that
// can rot into uselessness without anyone noticing: a guard that has stopped
// being able to throw looks identical to a healthy machine.
//
// So both directions are asserted here. A daemon that answers `/_ping` must
// be accepted; an endpoint with nothing behind it must throw, promptly.
//
// WHAT THIS COVERS AND WHAT IT DOES NOT
//
// The daemon is a stub HTTP server that answers `/_ping` with 200 — that is
// the entire contract the probe has with Docker, so a stub is the real
// contract, not a shortcut. The socket-path cases are therefore a test of
// the branch LOGIC ("does something answer at this path"), not of Colima or
// Rancher Desktop, neither of which is exercised here.
//
// Every case pins DOCKER_HOST, because that is the only way to aim the probe
// at one specific endpoint: with DOCKER_HOST unset the guard walks a fixed
// list and returns on the first success, so on a developer machine with a
// live standard socket the later entries are unreachable and nothing about
// them could be asserted. Ordering within that list is not covered here.
//
// PATH is emptied in every case so the `docker version` fallback cannot
// answer: without that a pass would be ambiguous (probe or CLI?) and a
// failure would pay the CLI timeout. That the real CLI does not rescue a
// dead DOCKER_HOST either — it inherits the same variable — was measured by
// hand on 2026-09-07 and is not re-measured here.

/** Docker's liveness endpoint, and the only route the stub serves. */
const PING_PATH = "/_ping";
const LOOPBACK = "127.0.0.1";
/** Emptied onto PATH so `execFile("docker", …)` fails with ENOENT at once. */
const NO_EXECUTABLES_PATH = "/nonexistent-rovenue-guard-path";
/** A TCP port nothing listens on. */
const DEAD_PORT = 12999;
/** Short root: macOS caps a unix socket path at ~104 bytes, and the default
 *  temp directory is long enough to matter. */
const SOCKET_ROOT = "/tmp";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** Set env for one test and restore it afterwards. */
function withEnv(overrides: Record<string, string | undefined>): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanups.push(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** A server that answers `/_ping` the way the daemon does and nothing else. */
function pingServer(): Server {
  const server = createServer((req, res) => {
    if (req.url === PING_PATH) {
      res.writeHead(200);
      res.end("OK");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  return server;
}

async function listenOnTcp(): Promise<number> {
  const server = pingServer();
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return address.port;
}

/** A directory under /tmp that is removed after the test. */
function scratchDir(): string {
  const dir = mkdtempSync(join(SOCKET_ROOT, "rvn-guard-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function listenOnSocket(socketPath: string): Promise<void> {
  await mkdir(dirname(socketPath), { recursive: true });
  const server = pingServer();
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
}

describe("docker daemon guard", () => {
  it("accepts a TCP endpoint that answers /_ping", async () => {
    const port = await listenOnTcp();
    withEnv({
      DOCKER_HOST: `tcp://${LOOPBACK}:${port}`,
      PATH: NO_EXECUTABLES_PATH,
    });
    await expect(setup()).resolves.toBeUndefined();
  });

  it("accepts an http:// endpoint that answers /_ping", async () => {
    const port = await listenOnTcp();
    withEnv({
      DOCKER_HOST: `http://${LOOPBACK}:${port}`,
      PATH: NO_EXECUTABLES_PATH,
    });
    await expect(setup()).resolves.toBeUndefined();
  });

  // The path shape is Colima's; what is under test is the unix-socket probe
  // that the Colima and Rancher Desktop entries both rely on.
  it("accepts a unix socket that answers /_ping", async () => {
    const socketPath = join(scratchDir(), ".colima", "default", "docker.sock");
    await listenOnSocket(socketPath);
    withEnv({
      DOCKER_HOST: `unix://${socketPath}`,
      PATH: NO_EXECUTABLES_PATH,
    });
    await expect(setup()).resolves.toBeUndefined();
  });

  it("throws when a TCP port has nothing behind it", async () => {
    const endpoint = `tcp://${LOOPBACK}:${DEAD_PORT}`;
    withEnv({ DOCKER_HOST: endpoint, PATH: NO_EXECUTABLES_PATH });
    await expect(setup()).rejects.toThrow(endpoint);
  });

  it("throws when a unix socket path does not exist", async () => {
    const socketPath = join(scratchDir(), ".rd", "docker.sock");
    withEnv({
      DOCKER_HOST: `unix://${socketPath}`,
      PATH: NO_EXECUTABLES_PATH,
    });
    await expect(setup()).rejects.toThrow(socketPath);
  });

  it("throws on a DOCKER_HOST scheme it cannot parse", async () => {
    withEnv({ DOCKER_HOST: "npipe:////./pipe/docker_engine", PATH: NO_EXECUTABLES_PATH });
    await expect(setup()).rejects.toThrow("unrecognised scheme");
  });

  it("names the container suite it is protecting, not just 'docker'", async () => {
    withEnv({
      DOCKER_HOST: `tcp://${LOOPBACK}:${DEAD_PORT}`,
      PATH: NO_EXECUTABLES_PATH,
    });
    // The message is the whole product here: a developer who hits this must
    // learn what stopped and why a skip was not an option.
    await expect(setup()).rejects.toThrow(
      /partman-registration\.integration\.test\.ts/,
    );
  });
});
