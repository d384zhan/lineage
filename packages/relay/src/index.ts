export { choosePort } from "./ports";
export { startRelay } from "./server";
export type { RelayHandle, RelayOptions, RoomTokenResolver } from "./server";
export { EMAIL_CLAIM, createTokenVerifier, deriveIdentity, normalizeIssuer } from "./auth";
export type { RelayAuthOptions, TokenVerifier } from "./auth";
export { createFakeIssuer } from "./test-issuer";
export type { FakeIssuer, SignClaims } from "./test-issuer";
