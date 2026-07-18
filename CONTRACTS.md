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
- Person 2's MCP server calls `LineageCore` instead of reading SQLite or Git.
- Person 2's wrapper sends normalized `SessionEvent` objects to
  `SessionEventSink`.
- Person 2 exports network commands as `LineageCommand[]` for the root CLI to
  register.

Mocks for both directions are exported from `@lineage/contracts/testing`.

Person 2 can obtain the real implementation without constructing storage:

```ts
import { openGitLineageRuntime } from "@lineage/git-store";

const runtime = await openGitLineageRuntime(process.cwd());
// runtime.core implements LineageCore and SessionEventSink
// runtime.repoId is used by the relay connection
```

## Repository identity

`lineage init` generates `.lineage/repo.json`:

```json
{
  "protocolVersion": 1,
  "repoId": "generated-uuid"
}
```

The committed `repoId` is the relay room identifier. Every intent and wire
message must contain this exact ID. Secrets and relay URLs must remain under
`.git/lineage` and must not be committed.

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
- `lineage_ask`
- `lineage_reply`
- `lineage_why`
- `lineage_timeline`
- `lineage_inbox`

The recipient approval result is one of `agent`, `manual`, or `reject`.

## History behavior

Raw `SessionEvent.content` is stored only in
`.git/lineage/lineage.sqlite`. Git notes contain approved `DecisionRecord` and
completed `IntentRecord` objects. Prompt content is represented by SHA-256
hashes.

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
