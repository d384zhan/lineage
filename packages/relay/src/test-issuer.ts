import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type JSONWebKeySet,
} from "jose";
import { EMAIL_CLAIM, normalizeIssuer } from "./auth";

export interface SignClaims {
  sub: string;
  email?: string;
  audience?: string;
  issuer?: string;
  expiresIn?: string;
}

/** Local RS256 issuer for tests — signs JWTs the relay can verify offline. */
export interface FakeIssuer {
  issuer: string;
  jwks: JSONWebKeySet;
  sign(claims: SignClaims): Promise<string>;
}

export async function createFakeIssuer(options: {
  audience: string;
  issuer?: string;
}): Promise<FakeIssuer> {
  const issuer = normalizeIssuer(options.issuer ?? "https://issuer.lineage.test");
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  jwk.kid = "lineage-test-key";
  jwk.alg = "RS256";
  jwk.use = "sig";
  return {
    issuer,
    jwks: { keys: [jwk] },
    async sign(claims) {
      const jwt = new SignJWT(
        claims.email ? { [EMAIL_CLAIM]: claims.email } : {},
      )
        .setProtectedHeader({ alg: "RS256", kid: "lineage-test-key" })
        .setSubject(claims.sub)
        .setIssuer(normalizeIssuer(claims.issuer ?? issuer))
        .setAudience(claims.audience ?? options.audience)
        .setIssuedAt()
        .setExpirationTime(claims.expiresIn ?? "10m");
      return await jwt.sign(privateKey);
    },
  };
}
