export { startDaemon } from "./daemon";
export type { DaemonHandle, DaemonOptions } from "./daemon";
export { DaemonClient } from "./client";
export type { DaemonStatus, InboxSnapshotEntry } from "./client";
export { Inbox } from "./inbox";
export type { InboxEntry, InboxStatus } from "./inbox";
export { Outbox } from "./outbox";
export type { OutboxEntry, OutboxStatus } from "./outbox";
export { ApprovalQueue, toInboundRequest } from "./approval";
export type { ApprovalIo, ApprovalOutcome } from "./approval";
export { createSubAgentAnswerer, resolveExecutable } from "./agent-answerer";
export type { AgentAnswerer, AgentAnswererContext, SubAgentOptions } from "./agent-answerer";
export { runUserPromptContextHooks } from "./prompt-hooks";
export type { PromptHookOptions } from "./prompt-hooks";
export { detectGitIdentities, parseGitIdentity } from "@lineage/git-store";
export { resolveRepositoryAuthorship } from "./authorship";
export { DAEMON_SECRET_HEADER } from "./http";
export type { CoreRuntime, RuntimeOpener } from "./http";
export {
  AuthSettingsSchema,
  HostSettingsSchema,
  MembershipSettingsSchema,
  NetworkSettingsSchema,
  DaemonInfoSchema,
  deleteAuthSettings,
  findGitDir,
  findRepoRoot,
  readAuthSettings,
  readDaemonInfo,
  readHostSettings,
  readMembershipSettings,
  readNetworkSettings,
  readRepoId,
  resolveStateDir,
  resolveUserStateDir,
  writeAuthSettings,
  writeDaemonInfo,
  writeHostSettings,
  writeMembershipSettings,
  writeNetworkSettings,
} from "./files";
export type {
  AuthSettings,
  DaemonInfo,
  HostSettings,
  MembershipSettings,
  NetworkSettings,
} from "./files";
export {
  decodeJwtPayload,
  ensureFreshAuth,
  identityFromAccessToken,
  pollForTokens,
  refreshAuth,
  requestDeviceCode,
  toAuthSettings,
} from "./oauth";
export type {
  DeviceCodeResponse,
  EnsureFreshOptions,
  Fetcher,
  OAuthConfig,
  PollOptions,
  TokenResponse,
} from "./oauth";
