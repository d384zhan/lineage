# Lineage

Git-native decision history and live coordination for coding agents.

Git tracks what changed; Lineage records why — the intents, assumptions, and
decisions behind each change — and lets developers (and their Claude/Codex
agents) ask each other questions across machines, with human approval.

This repository is a Bun workspace containing both halves:

- **History** (Person 1): contracts, decision/intent records, conflict
  detection, Git refs + notes persistence, and private prompt provenance.
- **Network** (Person 2): WebSocket relay, transport, local daemon with the
  approve/answer flow, MCP server for Claude Code and Codex, and the
  `host`/`tunnel`/`join`/`daemon`/`run`/`ask`/`reply`/`inbox` commands.

## Development

```bash
bun install
bun link        # exposes the `lineage` executable (used by the Git hook)
bun test
bun run typecheck
```

## Workspace ownership

- `packages/contracts`: shared, versioned schemas and interfaces (see CONTRACTS.md)
- `packages/core`: decision, intent, and conflict behavior
- `packages/git-store`: per-user intent refs and Git notes persistence
- `packages/prompt-index`: machine-wide Claude/Codex metadata index and exact source lookup
- `packages/commands-history`: history command implementations
- `packages/relay`: Bun WebSocket relay (rooms per repoId, token auth, routing, acks)
- `packages/transport`: `WebSocketLineageTransport` client with ask/answer correlation and reconnect
- `packages/daemon`: local hub for the relay connection, durable inbox, approvals, and localhost HTTP API
- `packages/mcp`: stdio MCP server exposing the `lineage_*` tools and Claude Channel wake-ups
- `packages/commands-network`: network commands and the `lineage run` agent wrapper
- `packages/cli`: CLI dispatcher registering both command sets

## Two-laptop demo runbook

One-time on each laptop: install [Bun](https://bun.sh), Git, and the agent CLI
(`claude` 2.1.80+ and/or `codex`), then `bun install && bun link` in this repo.

In the repository where you want to use Lineage, run `lineage init` once on
each computer. It derives the same room identity from the Git `origin`, stores
everything under `.git/lineage/`, registers installed Claude/Codex MCP clients,
and indexes existing sessions. It does not change the worktree or require a
commit. Rerun it after installing another agent CLI.

### Laptop A (hosts the relay, runs Codex)

```bash
lineage init                       # local setup; no files to commit
lineage host --port 8787           # terminal 1 — prints the room token
lineage join --relay ws://localhost:8787 --token <token> --user alice --provider codex
lineage run codex                  # terminal 2 — starts messaging invisibly
```

### Laptop B (Windows, clones the repo, runs Claude)

```bash
# clone the same Git repository; its origin produces the same Lineage room id
lineage init
lineage join --relay ws://<laptop-a-ip>:8787 --token <token> --user bob --provider claude
lineage run claude                  # requests and answers interrupt Claude
```

For computers on different networks, laptop A can run
`lineage tunnel --port 8787` and laptop B can use the printed `wss://` URL.

### Demo beats

1. Alice asks from Codex: `Ask Bob through Lineage why src/auth.ts:42 was implemented this way.`
2. Lineage returns a request ID immediately, then runs Git blame and routes the
   structured question only to Bob in the background.
3. Bob's active Claude session wakes and asks whether to dispatch Claude,
   answer manually, or reject.
4. On dispatch, Lineage privately matches Bob's native session history and
   runs Bob's configured `UserPromptSubmit` context hooks against the question.
   Claude receives the approved local context and returns a cited answer. Alice
   checks `lineage_requests` without having blocked her Codex session.
5. Alice commits; the post-commit hook links the session
   (`lineage link-commit`), storing the decision in Git notes.
6. Alice disconnects. `lineage why src/auth/...` on Laptop B still reconstructs
   the decision from Git.

## Notes and limitations (MVP)

- Room secrets, relay URLs, and daemon state live under `.git/lineage/` and are
  never committed. Git notes carry only approved structured decisions.
- `lineage join` captures the repository's effective Git name/email and carries
  it with the Lineage actor. Add aliases with repeated
  `--git-identity "Name <email>"` flags. Existing joins are upgraded at daemon
  startup from `git config`, so rejoining is not required.
  Use `lineage identity add "Name <email>"` for historical aliases and
  `lineage identity list` to inspect the mapping.
- Approved dispatches compute a memory-only authorship summary from up to 500
  commits across local refs, including whether referenced commits belong to the
  recipient. Agents are told to use that evidence instead of treating all code
  in a shared repository as the recipient's work. Authorship context is not
  stored in the inbox, Git notes, or the relay.
- Repository identity is a stable hash of the normalized Git `origin`, so SSH
  and HTTPS clones meet in the same room without a committed Lineage file. A
  repository without an origin falls back to its first commit; an empty local
  repository can use `lineage init --repo-id <shared-id>`.
- `~/.lineage/prompt-index.json` is private to one machine. It stores hashes,
  timestamps, touched files, and pointers into native agent JSONL files, not
  prompt text. Exact prompts are reread only after approval and are never sent
  to Git or the relay outside that answer.
- The local inbox persists under `.git/lineage/`. Matched exact prompts remain
  memory-only; a restarted dispatch returns to pending and requires approval again.
- Active-session dispatches run the recipient's unconditional command-based
  `UserPromptSubmit` hooks from Claude or Codex config. Plain Claude output and
  Codex `additionalContext` output are normalized into the same agent request.
  Standalone headless agents use their native hook lifecycle instead. Hook
  context remains memory-only and never enters Git, the inbox file, or the relay.
- Both Claude Code and Codex native session logs are indexed. `lineage run`
  refreshes the index after the agent exits; `lineage index` imports existing
  history, including sessions created before Lineage was installed.
- The MCP instructions tell agents to ground why/how/design questions in the
  narrowest relevant `path:line`. Broad status and coordination questions remain
  valid, but cannot select an exact originating prompt without a code anchor.
- Use `lineage run claude|codex` for live messaging. It owns the daemon for the
  life of the coding-agent session, so no separate daemon terminal is needed.
  Launching normally still exposes pull-based MCP tools but cannot guarantee wake-ups.
- Claude wake-ups use Claude Code Channels, currently a research-preview API.
  They are enabled by default for `lineage run claude`: new requests and
  completed answers interrupt the active session without blocking the sender.
  Use `--no-lineage-channel` to opt out. Codex has no equivalent Lineage
  Channel, so it checks completed answers through `lineage_requests`.
- The relay remains intentionally live-only for this MVP. Once the recipient's
  daemon accepts a question, its per-user inbox is durable; a fully offline
  recipient is reported to the asker instead of silently holding a request.
