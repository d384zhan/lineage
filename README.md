# Lineage

Git-native decision history and live coordination for coding agents.

Git tracks what changed; Lineage records why — the intents, assumptions, and
decisions behind each change — and lets developers (and their Claude/Codex
agents) ask each other questions across machines, with human approval.

This repository is a Bun workspace containing both halves:

- **History** (Person 1): contracts, decision/intent records, conflict
  detection, SQLite + Git notes persistence, `init`/`announce`/`why`/`timeline`.
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
- `packages/git-store`: SQLite session storage and Git notes persistence
- `packages/commands-history`: history command implementations
- `packages/relay`: Bun WebSocket relay (rooms per repoId, token auth, routing, acks)
- `packages/transport`: `WebSocketLineageTransport` client with ask/answer correlation and reconnect
- `packages/daemon`: long-running local hub — relay connection, inbox, a/m/r approval prompt, localhost HTTP API
- `packages/mcp`: stdio MCP server exposing the six `lineage_*` tools
- `packages/commands-network`: network commands and the `lineage run` agent wrapper
- `packages/cli`: CLI dispatcher registering both command sets

## Two-laptop demo runbook

One-time on each laptop: install [Bun](https://bun.sh), Git, and the agent CLI
(`claude` and/or `codex`), then `bun install && bun link` in this repo.

### Laptop A (hosts the relay, runs Claude)

```bash
lineage init                       # once per repo; commits .lineage/repo.json
lineage host --port 8787           # terminal 1 — prints the room token
lineage tunnel --port 8787         # terminal 2 — prints wss://xyz.trycloudflare.com
                                   #   (needs: winget install Cloudflare.cloudflared)
lineage join --relay ws://localhost:8787 --token <token> --user alice --provider claude
lineage daemon                     # terminal 3 — go online; approvals happen HERE
lineage run claude                 # terminal 4 — Claude with lineage MCP + capture
```

### Laptop B (clones the repo, runs Codex)

```bash
# clone the repo (which contains the committed .lineage/repo.json)
lineage join --relay wss://xyz.trycloudflare.com --token <token> --user bob --provider codex
lineage daemon                     # terminal 1
lineage run codex                  # terminal 2
```

### Demo beats

1. Alice announces:
   `lineage announce --summary "Token refresh" --user alice --assume auth.token_storage=httpOnly-cookie`
2. Bob announces the incompatible assumption
   (`--assume auth.token_storage=localStorage`) — **both daemons print the
   assumption conflict**.
3. Bob asks: `lineage ask alice "Why the cookie approach?"` (or Codex calls the
   `lineage_ask` MCP tool itself).
4. Alice's daemon terminal shows the question; she presses **a** — a headless
   `claude -p` sub-agent answers via the `lineage_reply` MCP tool (she could
   also answer **m**anually or **r**eject). The answer lands in Bob's terminal.
5. Alice commits; the post-commit hook links the session
   (`lineage link-commit`), storing the decision in Git notes.
6. Alice disconnects. `lineage why src/auth/...` on Laptop B still reconstructs
   the decision from Git.

## Notes and limitations (MVP)

- Room secrets, relay URLs, and daemon state live under `.git/lineage/` and are
  never committed. Raw prompts stay in the local SQLite; Git notes carry only
  approved records and prompt hashes.
- The daemon inbox is in-memory: unanswered questions do not survive a daemon
  restart.
- Session capture: Claude sessions are captured from the local transcript file
  (best-effort) plus MCP tool calls; Codex capture is tool-call-only.
- Live agents are never injected mid-turn: approved questions run a one-shot
  headless sub-agent, and are also surfaced through `lineage_inbox` / appended
  to MCP tool results for agents already at work.
