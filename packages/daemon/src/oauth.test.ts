import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { readAuthSettings, writeAuthSettings, type AuthSettings } from "./files";
import {
  ensureFreshAuth,
  identityFromAccessToken,
  pollForTokens,
  requestDeviceCode,
  toAuthSettings,
  type OAuthConfig,
} from "./oauth";

/** Unsigned but correctly shaped JWT — enough for client-side decoding. */
function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

interface FakeAuth0 {
  url: string;
  requests: Array<{ path: string; body: URLSearchParams }>;
  stop(): void;
}

function startFakeAuth0(options: {
  accessToken: string;
  pendingPolls?: number;
  refreshedToken?: string;
}): FakeAuth0 {
  let polls = 0;
  const requests: FakeAuth0["requests"] = [];
  const server: Server<undefined> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const body = new URLSearchParams(await request.text());
      requests.push({ path: url.pathname, body });
      if (url.pathname === "/oauth/device/code") {
        return Response.json({
          device_code: "device-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://issuer.test/activate",
          verification_uri_complete: "https://issuer.test/activate?user_code=ABCD-EFGH",
          expires_in: 300,
          interval: 1,
        });
      }
      if (url.pathname === "/oauth/token") {
        if (body.get("grant_type") === "refresh_token") {
          if (body.get("refresh_token") !== "refresh-1") {
            return Response.json({ error: "invalid_grant" }, { status: 403 });
          }
          return Response.json({
            access_token: options.refreshedToken ?? options.accessToken,
            expires_in: 3600,
          });
        }
        if (polls < (options.pendingPolls ?? 0)) {
          polls += 1;
          return Response.json({ error: "authorization_pending" }, { status: 403 });
        }
        return Response.json({
          access_token: options.accessToken,
          refresh_token: "refresh-1",
          expires_in: 3600,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

const servers: FakeAuth0[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const server of servers) server.stop();
  servers.length = 0;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function fakeServer(options: Parameters<typeof startFakeAuth0>[0]): FakeAuth0 {
  const server = startFakeAuth0(options);
  servers.push(server);
  return server;
}

describe("oauth device flow", () => {
  test("requests a device code and polls until the browser login completes", async () => {
    const accessToken = fakeJwt({ sub: "auth0|1", email: "alice@example.com" });
    const auth0 = fakeServer({ accessToken, pendingPolls: 2 });
    const config: OAuthConfig = {
      domain: auth0.url,
      clientId: "client-1",
      audience: "https://lineage.example/api",
    };

    const device = await requestDeviceCode(config);
    expect(device.user_code).toBe("ABCD-EFGH");
    expect(auth0.requests[0]!.body.get("scope")).toContain("offline_access");

    const tokens = await pollForTokens(config, device, { sleep: async () => {} });
    expect(tokens.access_token).toBe(accessToken);
    expect(tokens.refresh_token).toBe("refresh-1");

    const settings = toAuthSettings(config, tokens);
    expect(settings.identity).toBe("alice@example.com");
    expect(Date.parse(settings.expiresAt)).toBeGreaterThan(Date.now());
  });

  test("derives identity from sub when the token has no email claim", () => {
    expect(identityFromAccessToken(fakeJwt({ sub: "auth0|steve" }))).toBe("auth0|steve");
  });

  test("ensureFreshAuth refreshes an expired token and persists the result", async () => {
    const freshToken = fakeJwt({ sub: "auth0|1", email: "alice@example.com" });
    const auth0 = fakeServer({ accessToken: freshToken, refreshedToken: freshToken });
    const stateDir = mkdtempSync(join(tmpdir(), "lineage-oauth-"));
    tempDirs.push(stateDir);

    const stale: AuthSettings = {
      domain: auth0.url,
      clientId: "client-1",
      audience: "https://lineage.example/api",
      accessToken: fakeJwt({ sub: "auth0|1", email: "alice@example.com" }),
      refreshToken: "refresh-1",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      identity: "alice@example.com",
    };
    await writeAuthSettings(stateDir, stale);

    const refreshed = await ensureFreshAuth(stateDir);
    expect(refreshed!.accessToken).toBe(freshToken);
    expect(Date.parse(refreshed!.expiresAt)).toBeGreaterThan(Date.now());
    // Rotation absent → the stored refresh token is kept.
    expect(refreshed!.refreshToken).toBe("refresh-1");
    const persisted = await readAuthSettings(stateDir);
    expect(persisted!.accessToken).toBe(freshToken);
  });

  test("ensureFreshAuth leaves valid tokens alone and returns undefined without a login", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "lineage-oauth-"));
    tempDirs.push(stateDir);
    expect(await ensureFreshAuth(stateDir)).toBeUndefined();

    const valid: AuthSettings = {
      domain: "https://unreachable.invalid",
      clientId: "client-1",
      audience: "https://lineage.example/api",
      accessToken: fakeJwt({ sub: "auth0|1" }),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      identity: "auth0|1",
    };
    await writeAuthSettings(stateDir, valid);
    // Never contacts the (unreachable) tenant when the token is still fresh.
    const result = await ensureFreshAuth(stateDir);
    expect(result).toEqual(valid);
  });
});
