# Lineage v1 contracts

This document is the integration boundary between the history implementation
(Person 1) and the networking/agent implementation (Person 2). The executable
schemas and interfaces in `@lineage/contracts` are authoritative.

## Ownership

Person 1 owns `core`, `git-store`, `commands-history`, and the current CLI
dispatcher. Person 2 may implement the relay, transport, MCP server, PTY
wrapper, and network commands in any package layout without changing Person 1
packages.

The only required integration points are:

- Person 2 implements `LineageTransport`.
- Person 2's MCP server calls `LineageCore` instead of reading Git directly.
- Person 2 exports network commands as `LineageCommand[]` for the root CLI to
  register.

Mocks for both directions are exported from `@lineage/contracts/testing`.

Person 2 can obtain the real implementation without constructing storage:

```ts
import { openGitLineageRuntime } from "@lineage/git-store";

const runtime = await openGitLineageRuntime(process.cwd());
// runtime.core implements LineageCore
// runtime.repoId is used by the relay connection
```

## Repository identity

`lineage init` writes `<git-dir>/lineage/repo.json`:

```json
{
  "protocolVersion": 1,
  "repoId": "generated-uuid"
}
```

The `repoId` is the relay room identifier. By default it is a stable hash of
the normalized Git `origin`, so `git@host:owner/repo.git` and
`https://host/owner/repo.git` derive the same value independently. Repositories
without an origin fall back to the first commit or an explicit `--repo-id`.
Every intent and wire message must contain this exact ID. Repository identity,
secrets, and relay URLs remain under `.git/lineage` and are never committed.

Initialization also registers the Lineage stdio MCP server through each
installed provider's supported CLI. Claude uses local project scope; Codex uses
its user MCP configuration. This setup is idempotent and creates no project
configuration file. `lineage run` is optional after initialization.

## Wire protocol

Send one UTF-8 JSON `WireEnvelope` per WebSocket text frame. The allowed types
are `hello`, `presence`, `intent.announce`, `question.ask`, `question.answer`,
`question.reject`, `ack`, and `error`.

The first client message must be `hello`. The relay validates its room token
before routing later messages. It must reject mismatched protocol versions,
rooms, recipients, and tokens with the shared `ErrorCode` values.

For questions, generate one `requestId` and copy it into the ask envelope,
answer/rejection envelope, and `AgentAnswer`. The shared schema rejects a
mismatched answer ID. An `intent.announce` payload must use the envelope's
`repoId`.

Two clarifications pinned down by the transport implementation:

- The asker's transport generates the `requestId` inside `ask()`; callers never
  supply one (`AskInput` has no such field).
- The relay also acks the `hello` envelope; clients use that ack as the
  connect-success signal.

### Optional Auth0 identity

The `hello` payload carries an optional `accessToken` (a JWT), and
`ConnectionConfig` mirrors the field. A relay started **without** auth
configuration ignores it and keeps room-token behavior. A relay started
**with** auth configuration (issuer + audience) requires the token, verifies
it against the issuer's JWKS (RS256, `iss`/`aud`/`exp`), derives the caller's
identity as `email claim ?? sub`, and rejects the hello with `invalid_token`
unless `sender.userId` equals that identity. Room-token equality is not
optional for a generic authenticated relay: without a membership authorizer,
the relay requires both the room token and JWT. `lineage host` supplies a
repo-scoped membership authorizer instead. It prompts the host for first-time
verified identities and persists approvals locally; in that mode host approval
replaces the shared room token. After a successful hello the relay also rejects
any later envelope whose `sender.userId` differs from the authenticated one.

Question recipients are resolved against the online room roster. Exact userId
matches win; otherwise a unique email prefix, Git identity name, or name token
resolves to the canonical userId. Multiple matches return
`recipient_ambiguous` with candidates instead of being reported offline.

After a local `core.announce`, publish its returned `intent` as an
`intent.announce` envelope. When a remote envelope arrives, pass its payload to
`core.ingestRemoteIntent`; the returned conflicts are the local warning set.

Fixtures covering every message type live in
`packages/contracts/fixtures/wire.json`.

## Agent bridge

The wrapper identifies sessions using these environment variables:

```text
LINEAGE_SESSION_ID
LINEAGE_USER_ID
LINEAGE_PROVIDER
```

Use `renderInboundAgentRequest()` to construct approved agent input. Do not
create a provider-specific prompt format. The receiving agent returns its
answer through `lineage_reply`; Person 2 must not scrape terminal prose to infer
which question was answered.

The fixed MCP tool names are exported as `MCP_TOOL_NAMES`:

- `lineage_announce`
- `lineage_record_decision`
- `lineage_ask`
- `lineage_requests`
- `lineage_respond`
- `lineage_reply`
- `lineage_why`
- `lineage_timeline`
- `lineage_inbox`

The recipient approval result is one of `agent`, `manual`, or `reject`.
`lineage_ask` carries `question`, `request`, and one-way `context` messages so
the MCP surface does not need a separate steering tool. Its optional
`sourceSessionId` is runtime routing metadata: same-user recipients are allowed
only for session-tagged asks, and the source MCP session suppresses its own
inbound event.

## History behavior

Lineage never copies raw prompts into Git or its own index. The machine-wide
private index stores hashes, timestamps, repository identity, touched files,
and a source-file/line pointer into Claude Code or Codex's native JSONL history.
This lets old sessions be indexed without requiring the developer to have run
their agent through Lineage.

For a `path:line` query, Git blame identifies the commit. Lineage ranks local
prompt pointers using repository identity, tool-touched files, commit time, and
hashed term overlap. After the recipient explicitly approves an agent answer,
the daemon rereads the best high-confidence prompt from its native JSONL source.
`AgentAnswer.quotedPrompt` may carry that prompt back to the requester. It is
transient and must never be written to Git or the prompt index. Durable history
contains only the agent's structured summary and rationale.

Current intent is stored in a per-user ref under
`refs/lineage/intents/<user>-<hash>`. Each update creates a Git commit whose
parent is the user's previous intent, giving the ref its own append-only
chronology without touching the code branch. Approved decisions and completed
intents remain attached to code commits through Git notes.

`lineage sync` pushes and fetches only `refs/lineage/intents/*` and
`refs/notes/lineage/*`. The WebSocket transport remains responsible for live
delivery.

The MVP conflict rule is deterministic: two active intents conflict when an
assumption key matches case-insensitively and its whitespace-normalized value
differs case-insensitively.

## Changing a contract

A contract change is complete only when the same commit includes:

1. Updated Zod schema and exported TypeScript type.
2. Updated JSON fixture.
3. Updated `MockLineageCore` or `MockLineageTransport` when applicable.
4. Passing producer and consumer contract tests.

Do not duplicate shared types inside relay or MCP packages.
