# Lineage

Git-native decision history and live coordination contracts for coding agents.

This repository is a Bun workspace. The initial implementation contains the
shared protocol between the history and networking halves of Lineage, plus the
Git-backed history implementation.

## Development

```bash
bun install
bun link
bun test
bun run typecheck
```

`bun link` exposes the `lineage` executable used by the optional Git hook.

## Workspace ownership

- `packages/contracts`: shared, versioned schemas and interfaces
- `packages/core`: decision, intent, and conflict behavior
- `packages/git-store`: per-user intent refs and Git notes persistence
- `packages/commands-history`: Person 1 command implementations
- `packages/cli`: CLI dispatcher for the implemented history commands

The relay, transport, MCP server, and agent bridge consume the shared contracts
but are intentionally not implemented in this foundation.
