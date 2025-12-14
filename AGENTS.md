# AGENTS.md

## Project Overview

**amp-acp** is a Node.js adapter that bridges [Amp CLI](https://ampcode.com) to the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/), enabling Amp to work with ACP-compatible clients like [Zed](https://zed.dev).

## Tech Stack

- **Runtime**: Node.js (ES modules)
- **Protocol**: Agent Client Protocol (ACP) SDK v0.11.0
- **Testing**: Vitest
- **Entry Point**: `src/index.js`

## Commands

| Task | Command |
|------|---------|
| Run | `npm start` or `node src/index.js` |
| Test | `npm test` |
| Test (watch) | `npm run test:watch` |
| Lint | `npm run lint` (no-op) |

## Architecture

```
src/
├── index.js      # Entry point, console redirection, global error handlers
├── run-acp.js    # ACP server bootstrap, connection lifecycle
├── server.js     # AmpAcpAgent class - session management, spawns Amp CLI
├── config.js     # Centralized configuration, tool mappings, slash commands
├── to-acp.js     # Converts Amp JSON messages to ACP notifications
└── utils.js      # Stream conversion utilities

test/
├── config.test.js  # Tests for tool kind/title mappings, slash commands
└── to-acp.test.js  # Tests for message conversion
```

## Key Behaviors

- **stdout is reserved** for ACP stream; all logging must go to stderr
- Each prompt spawns a fresh `amp --execute --stream-json --no-notifications` process
- Sessions are ephemeral per Amp turn (no persistent Claude Code context between prompts)
- **Timeout**: Processes killed after `AMP_ACP_TIMEOUT_MS` (default: 10 minutes)
- **Serialized events**: Readline events processed sequentially to prevent race conditions
- **Connection cleanup**: Uses `connection.signal` to abort in-flight prompts on disconnect

## ACP Features Implemented

### Connection Lifecycle
- Captures `AgentSideConnection.signal` to detect connection closure
- Aborts in-flight Amp processes when connection drops
- Logs connection state changes to stderr

### Terminal API (Bash Tool)
- Routes Bash command output through ACP Terminal API when client supports `terminal` capability
- Creates terminal on `tool_use` for Bash, releases on `tool_result`
- Embeds terminal ID in tool call content: `{ type: "terminal", terminalId }`

### Agent Plan Updates
- Maps `todo_write`/`todo_read` tool calls to ACP Plan updates
- Emits `session/update` with `sessionUpdate: "plan"` and `entries` array
- Tracks plan state per session

### Slash Commands
- Exposes `/plan`, `/code`, `/yolo`, `/ask`, `/architect` commands via `available_commands_update`
- Intercepts prompts starting with `/command` and calls `setSessionMode()`
- Commands map to Amp modes in `config.commandToMode`
- **Emission timing**: Commands are emitted via `setImmediate()` after session creation to ensure the `session/new` or `session/load` response is processed first by clients (fixes Zed compatibility)
- **Idempotency**: Each session tracks `sentAvailableCommands` flag to prevent duplicate emissions
- **Self-healing fallback**: Commands are emitted at prompt start if not already sent

### Tool Call Status Progression
- `tool_use`: Emits `tool_call` with `status: "pending"`
- Immediately emits `tool_call_update` with `status: "in_progress"`
- `tool_result`: Emits `tool_call_update` with `status: "completed"` or `"failed"`

### Session Load / Thread Continuation
- Implements ACP `session/load` using Amp thread IDs (`T-<uuid>`)
- Captures `session_id` from Amp JSON messages and stores as `threadId`
- On `loadSession`: fetches history via `amp threads markdown T-xxx`, replays as `agent_message_chunk`
- Subsequent prompts use `amp threads continue T-xxx --execute --stream-json`
- Emits thread URL via `agent_thought_chunk` on session start

### Enhanced Capability Declaration
```js
agentCapabilities: {
  promptCapabilities: { image: true, embeddedContext: true },
  loadSession: true,  // Supports thread continuation
  sessionCapabilities: { fork: false, resume: false },
  mcpCapabilities: null,  // Amp handles MCP internally
}
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `AMP_EXECUTABLE` | Path to Amp CLI binary | `amp` |
| `AMP_PREFER_SYSTEM_PATH` | Set to `1` to strip npx paths and use system Amp | - |
| `AMP_ACP_TIMEOUT_MS` | Prompt timeout in milliseconds | `600000` (10 min) |
| `AMP_ACP_NESTED_MODE` | `inline` (embed child tools in parent) or `separate` (individual tool cards) | `inline` |

## Code Style

- ES modules (`"type": "module"`)
- No TypeScript; plain JavaScript
- Minimal dependencies
- ACP ToolKind values must be spec-compliant: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`

## Versioning & Changelog

### File Locations

| File | Purpose |
|------|---------|
| `package.json` | Source of truth for version (semver) |
| `CHANGELOG.md` | User-facing change history ([Keep a Changelog](https://keepachangelog.com/)) |
| `scripts/bump-version.sh` | Atomic version bump script |

### Changelog Maintenance (AI Agents)

**When to add entries:** After completing any user-visible change (features, fixes, API changes, behavior changes).

**How to add entries:**
1. Edit `CHANGELOG.md`
2. Add entry under `## [Unreleased]` in the appropriate category
3. Use imperative mood ("Add feature" not "Added feature")
4. Include issue/PR references when applicable

**Categories (in order):**
- `### Added` — New features
- `### Changed` — Changes to existing functionality
- `### Deprecated` — Features marked for removal
- `### Removed` — Removed features
- `### Fixed` — Bug fixes
- `### Security` — Security-related changes

**Example entry:**
```markdown
## [Unreleased]

### Added
- Support for image attachments in prompts (#42)

### Fixed
- Race condition in readline event processing
```

### Version Bumping (AI Agents)

**When to bump:** Only on explicit release request, NOT per-commit.

**Bump types (Semantic Versioning):**
| Type | When | Example |
|------|------|---------|
| `patch` | Bug fixes, minor improvements | 0.2.0 → 0.2.1 |
| `minor` | New features, backward-compatible | 0.2.0 → 0.3.0 |
| `major` | Breaking changes | 0.2.0 → 1.0.0 |

**How to bump:**
```bash
./scripts/bump-version.sh patch   # or minor, major
```

This script atomically:
1. Updates `package.json` version
2. Moves `[Unreleased]` entries to new version section with date
3. Updates comparison links

**Post-bump steps (manual):**
```bash
git commit -am "Release vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```
