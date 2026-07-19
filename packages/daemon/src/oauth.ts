import { deriveIdentity, normalizeIssuer } from "@lineage/relay";
import { z } from "zod";
import { readAuthSettings, writeAuthSettings, type AuthSettings } from "./files";

/** Tenant coordinates for the Device Authorization Flow. */
export interface OAuthConfig {
  domain: string;
  clientId: string;
  audience: string;
}

export type Fetcher = typeof fetch;

const DeviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  verification_uri_complete: z.string().min(1).optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().default(5),
});

export type DeviceCodeResponse = z.infer<typeof DeviceCodeResponseSchema>;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
});

export type TokenResponse = z.infer<typeof TokenResponseSchema>;

/** Decodes a JWT's payload without verifying it (used on our own tokens). */
export function decodeJwtPayload(token: string): Record<string, unknown> {
  const segments = token.split(".");
  if (segments.length < 2) throw new Error("Access token is not a JWT");
  const base64 = segments[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
}

/** Same identity rule the relay applies: email claim, else sub. */
export function identityFromAccessToken(token: string): string {
  return deriveIdentity(decodeJwtPayload(token));
}

async function postForm(
  fetcher: Fetcher,
  url: string,
  body: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

export async function requestDeviceCode(
  config: OAuthConfig,
  fetcher: Fetcher = fetch,
): Promise<DeviceCodeResponse> {
  const issuer = normalizeIssuer(config.domain);
  const { status, json } = await postForm(fetcher, `${issuer}oauth/device/code`, {
    client_id: config.clientId,
    audience: config.audience,
    scope: "openid profile email offline_access",
  });
  if (status !== 200) {
    throw new Error(`Device code request failed (${status}): ${JSON.stringify(json)}`);
  }
  return DeviceCodeResponseSchema.parse(json);
}

export interface PollOptions {
  fetcher?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  /** Overall deadline in ms; defaults to the device code's expires_in. */
  timeoutMs?: number;
}

export async function pollForTokens(
  config: OAuthConfig,
  device: DeviceCodeResponse,
  options: PollOptions = {},
): Promise<TokenResponse> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const issuer = normalizeIssuer(config.domain);
  const deadline = Date.now() + (options.timeoutMs ?? device.expires_in * 1000);
  let intervalMs = device.interval * 1000;

  while (Date.now() < deadline) {
    const { status, json } = await postForm(fetcher, `${issuer}oauth/token`, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
      client_id: config.clientId,
    });
    if (status === 200) return TokenResponseSchema.parse(json);
    const error = (json as { error?: string }).error;
    if (error === "authorization_pending") {
      await sleep(intervalMs);
      continue;
    }
    if (error === "slow_down") {
      intervalMs += 1000;
      await sleep(intervalMs);
      continue;
    }
    if (error === "access_denied") throw new Error("Login was denied in the browser");
    if (error === "expired_token") throw new Error("The device code expired; run `lineage login` again");
    throw new Error(`Token request failed (${status}): ${JSON.stringify(json)}`);
  }
  throw new Error("Timed out waiting for the browser login");
}

export function toAuthSettings(
  config: OAuthConfig,
  tokens: TokenResponse,
  now: () => number = Date.now,
): AuthSettings {
  return {
    domain: config.domain,
    clientId: config.clientId,
    audience: config.audience,
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    expiresAt: new Date(now() + tokens.expires_in * 1000).toISOString(),
    identity: identityFromAccessToken(tokens.access_token),
  };
}

export async function refreshAuth(
  settings: AuthSettings,
  fetcher: Fetcher = fetch,
): Promise<AuthSettings> {
  if (!settings.refreshToken) {
    throw new Error("No refresh token stored; run `lineage login` again");
  }
  const issuer = normalizeIssuer(settings.domain);
  const { status, json } = await postForm(fetcher, `${issuer}oauth/token`, {
    grant_type: "refresh_token",
    client_id: settings.clientId,
    refresh_token: settings.refreshToken,
  });
  if (status !== 200) {
    throw new Error(`Token refresh failed (${status}); run \`lineage login\` again`);
  }
  const tokens = TokenResponseSchema.parse(json);
  return {
    ...toAuthSettings(settings, tokens),
    // Auth0 may or may not rotate the refresh token; keep the old one if not.
    refreshToken: tokens.refresh_token ?? settings.refreshToken,
  };
}

export interface EnsureFreshOptions {
  fetcher?: Fetcher;
  now?: () => number;
  /** Refresh when the token expires within this window (default 60s). */
  skewMs?: number;
}

/**
 * Loads stored login state, refreshing the access token when it is (nearly)
 * expired. Returns undefined when the user never logged in. A failed refresh
 * throws so callers can tell the user to log in again.
 */
export async function ensureFreshAuth(
  stateDir: string,
  options: EnsureFreshOptions = {},
): Promise<AuthSettings | undefined> {
  const settings = await readAuthSettings(stateDir);
  if (!settings) return undefined;
  const now = options.now ?? Date.now;
  const skewMs = options.skewMs ?? 60_000;
  if (Date.parse(settings.expiresAt) - skewMs > now()) return settings;
  const refreshed = await refreshAuth(settings, options.fetcher);
  await writeAuthSettings(stateDir, refreshed);
  return refreshed;
}
