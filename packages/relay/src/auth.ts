import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";

/** Namespaced claim a tenant Action can use to expose the login email. */
export const EMAIL_CLAIM = "https://lineage.dev/email";

export interface RelayAuthOptions {
  /** Auth0 tenant domain ("dev-abc.us.auth0.com") or full issuer URL. */
  issuer: string;
  /** Expected `aud` claim — the Auth0 API identifier. */
  audience: string;
  /** Inline key set for tests; defaults to `<issuer>.well-known/jwks.json`. */
  jwks?: JSONWebKeySet;
}

export interface TokenVerifier {
  /** Resolves to the caller's identity (email claim, else `sub`). */
  verify(token: string): Promise<string>;
}

/** Accepts a bare tenant domain or a URL; returns `https://.../` form. */
export function normalizeIssuer(input: string): string {
  const withScheme = /^https?:\/\//.test(input) ? input : `https://${input}`;
  return withScheme.endsWith("/") ? withScheme : `${withScheme}/`;
}

export function deriveIdentity(claims: JWTPayload): string {
  const email = claims[EMAIL_CLAIM] ?? claims["email"];
  if (typeof email === "string" && email.length > 0) return email;
  if (typeof claims.sub === "string" && claims.sub.length > 0) return claims.sub;
  throw new Error("Token has no email or sub claim to derive an identity from");
}

export function createTokenVerifier(options: RelayAuthOptions): TokenVerifier {
  const issuer = normalizeIssuer(options.issuer);
  const keySource = options.jwks
    ? createLocalJWKSet(options.jwks)
    : createRemoteJWKSet(new URL(`${issuer}.well-known/jwks.json`));
  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, keySource, {
        issuer,
        audience: options.audience,
      });
      return deriveIdentity(payload);
    },
  };
}
