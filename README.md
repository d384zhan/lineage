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
- `packages/daemon`: long-running local hub — relay connection, inbox, a/m/r approval prompt, localhost HTTP API
- `packages/mcp`: stdio MCP server exposing the seven `lineage_*` tools
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
lineage index                      # indexes existing Claude + Codex sessions
lineage daemon                     # terminal 3 — go online; approvals happen HERE
lineage run claude                 # terminal 4 — Claude with lineage MCP + capture
```

### Laptop B (clones the repo, runs Codex)

```bash
# clone the repo (which contains the committed .lineage/repo.json)
lineage join --relay wss://xyz.trycloudflare.com --token <token> --user bob --provider codex
lineage index
lineage daemon                     # terminal 1
lineage run codex                  # terminal 2
```

### Demo beats

1. Alice announces:
   `lineage announce --summary "Token refresh" --user alice --assume auth.token_storage=httpOnly-cookie`
2. Bob announces the incompatible assumption
   (`--assume auth.token_storage=localStorage`) — **both daemons print the
   assumption conflict**.
3. Bob asks: `lineage ask alice --line src/auth.ts:42`. Lineage runs Git blame,
   sends the commit and line as structured evidence, and Alice's daemon matches
   it against her local Claude/Codex history.
4. Alice's daemon terminal shows the question; she presses **a** — a headless
   `claude -p` sub-agent receives the matched exact prompt and answers via the
   `lineage_reply` MCP tool (she could also answer **m**anually or **r**eject).
   The answer and exact prompt land in Bob's terminal.
5. Alice commits; the post-commit hook links the session
   (`lineage link-commit`), storing the decision in Git notes.
6. Alice disconnects. `lineage why src/auth/...` on Laptop B still reconstructs
   the decision from Git.

## Notes and limitations (MVP)

- Room secrets, relay URLs, and daemon state live under `.git/lineage/` and are
  never committed. Git notes carry only approved structured decisions.
- `~/.lineage/prompt-index.json` is private to one machine. It stores hashes,
  timestamps, touched files, and pointers into native agent JSONL files, not
  prompt text. Exact prompts are reread only after approval and are never sent
  to Git or the relay outside that answer.
- The daemon inbox is in-memory: unanswered questions do not survive a daemon
  restart.
- Both Claude Code and Codex native session logs are indexed. `lineage run`
  refreshes the index after the agent exits; `lineage index` imports existing
  history, including sessions created before Lineage was installed.
- Live agents are never injected mid-turn: approved questions run a one-shot
  headless sub-agent, and are also surfaced through `lineage_inbox` / appended
  to MCP tool results for agents already at work.
