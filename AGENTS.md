# AGENTS.md

## Project Overview

**@edlsh/amp-acp** is a Node.js adapter bridging [Amp CLI](https://ampcode.com) to the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/), enabling Amp to work with ACP-compatible clients like [Zed](https://zed.dev).

| Attribute        | Value                                    |
| ---------------- | ---------------------------------------- |
| **Runtime**      | Node.js (ES modules)                     |
| **Protocol**     | ACP SDK v0.11.0                          |
| **Testing**      | Vitest                                   |
| **Entry Point**  | `src/index.js`                           |
| **Dependencies** | Minimal; plain JavaScript, no TypeScript |

---

## Agent Behavioral Constraints

<output_verbosity_spec>

- Default responses: direct conclusions first, then reasoning (≤5 bullets)
- Trivial tasks: ≤3 sentences or code-only
- Do not echo back user requests or explain basic JavaScript/Node.js concepts
- Do not narrate tool usage; state outcomes only
  </output_verbosity_spec>

<design_and_scope_constraints>

- Implement EXACTLY what was requested; no unsolicited features
- Do not rewrite unrelated subsystems when fixing local bugs
- When ambiguous, choose the simplest valid interpretation
- Preserve existing code style, patterns, and abstractions
  </design_and_scope_constraints>

<user_updates_spec>

- Brief updates only at major phase transitions
- Final summary: what changed (files/functions), how to validate, follow-up items
- No step-by-step narration during execution
  </user_updates_spec>

---

## Mandatory Tool Usage

<tool_usage_rules>

### Morph MCP — REQUIRED for All Code Operations

**Codebase Analysis (MUST use before any modification):**

```
morph-mcp___warpgrep_codebase_search  — Primary search tool for exploring code
morph-mcp___codebase_search           — Semantic search when warpgrep insufficient
```

**File Editing (MUST use for all file modifications):**

```
morph-mcp___edit_file                 — Primary tool for ALL file edits
```

**Enforcement Rules:**

1. NEVER use legacy Edit/MultiEdit tools; always use `morph-mcp___edit_file`
2. NEVER modify files without first searching with `warpgrep_codebase_search`
3. Use `// ... existing code ...` placeholders in edit_file calls
4. Batch all edits to the same file in a single `edit_file` call
5. If `edit_file` fails, retry once with more context lines before falling back

**Parallelization:**

- Parallelize independent read/search operations
- Never parallelize writes to the same file
- After writes, briefly restate what changed
  </tool_usage_rules>

---

## Commands

| Task         | Command                            |
| ------------ | ---------------------------------- |
| Run          | `npm start` or `node src/index.js` |
| Test         | `npm test`                         |
| Test (watch) | `npm run test:watch`               |
| Lint         | `npm run lint` (no-op currently)   |

**Verification requirement:** Run `npm test` after any code changes. Do not mark task complete if tests fail.

---

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

### Critical Invariants

| Constraint                     | Rationale                                        |
| ------------------------------ | ------------------------------------------------ |
| stdout reserved for ACP stream | All logging → stderr only                        |
| Fresh process per prompt       | `amp --execute --stream-json --no-notifications` |
| Ephemeral sessions             | No persistent context between prompts            |
| 10-min timeout                 | `AMP_ACP_TIMEOUT_MS` kills hung processes        |
| Serialized readline events     | Prevents race conditions                         |
| Connection signal cleanup      | Aborts in-flight prompts on disconnect           |

---

## ACP Features Reference

### Connection Lifecycle

- Captures `AgentSideConnection.signal` for closure detection
- Aborts in-flight Amp processes on connection drop
- Logs state changes to stderr

### Terminal API (Bash Tool)

- Routes Bash output through ACP Terminal API when `terminal` capability present
- Creates terminal on `tool_use`, releases on `tool_result`
- Embeds terminal ID: `{ type: "terminal", terminalId }`

### Plan Updates

- Maps `todo_write`/`todo_read` → ACP Plan updates
- Emits `session/update` with `sessionUpdate: "plan"` and `entries` array

### Slash Commands

| Command | Amp Mode |
| ------- | -------- |
| `/plan` | plan     |
| `/code` | code     |
| `/yolo` | yolo     |

- Emitted via `setImmediate()` after session creation (Zed compatibility)
- Tracks `sentAvailableCommands` flag for idempotency
- Self-healing fallback at prompt start if not already sent

### Tool Call Status Flow

```
tool_use → tool_call (pending) → tool_call_update (in_progress)
tool_result → tool_call_update (completed|failed)
```

### Session Load / Thread Continuation

- Thread IDs: `T-<uuid>` format
- `loadSession`: fetches via `amp threads markdown T-xxx`, replays as `agent_message_chunk`
- Continuation: `amp threads continue T-xxx --execute --stream-json`

### Capability Declaration

```js
agentCapabilities: {
  promptCapabilities: { image: true, embeddedContext: true },
  loadSession: true,
  sessionCapabilities: { fork: false, resume: false },
  mcpCapabilities: null,  // Amp handles MCP internally
}
```

---

## Environment Variables

| Variable                 | Purpose                                       | Default           |
| ------------------------ | --------------------------------------------- | ----------------- |
| `AMP_EXECUTABLE`         | Path to Amp CLI binary                        | `amp`             |
| `AMP_PREFER_SYSTEM_PATH` | Set `1` to strip npx paths, use system Amp    | —                 |
| `AMP_ACP_TIMEOUT_MS`     | Prompt timeout (ms)                           | `600000` (10 min) |
| `AMP_ACP_NESTED_MODE`    | `inline` or `separate` for child tool display | `separate`        |

---

## Code Style

| Rule            | Specification                                                                                                   |
| --------------- | --------------------------------------------------------------------------------------------------------------- |
| Module system   | ES modules (`"type": "module"`)                                                                                 |
| Language        | Plain JavaScript; no TypeScript                                                                                 |
| Dependencies    | Minimal; justify additions                                                                                      |
| ToolKind values | Spec-compliant: `read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other` |

---

## Versioning & Changelog

### Files

| File                      | Purpose                                |
| ------------------------- | -------------------------------------- |
| `package.json`            | Version source of truth (semver)       |
| `CHANGELOG.md`            | User-facing history (Keep a Changelog) |
| `scripts/bump-version.sh` | Atomic version bump script             |

### Changelog Rules (AI Agents)

**When:** After any user-visible change (features, fixes, API changes, behavior changes)

**How:**

1. Edit `CHANGELOG.md` under `## [Unreleased]`
2. Use imperative mood ("Add" not "Added")
3. Include issue/PR refs when applicable

**Categories (in order):** Added → Changed → Deprecated → Removed → Fixed → Security

**Example:**

```markdown
## [Unreleased]

### Added

- Support for image attachments in prompts (#42)

### Fixed

- Race condition in readline event processing
```

### Version Bumping

**When:** Only on explicit release request, NOT per-commit

| Type    | When                              | Example       |
| ------- | --------------------------------- | ------------- |
| `patch` | Bug fixes, minor improvements     | 0.2.0 → 0.2.1 |
| `minor` | New features, backward-compatible | 0.2.0 → 0.3.0 |
| `major` | Breaking changes                  | 0.2.0 → 1.0.0 |

**Command:**

```bash
./scripts/bump-version.sh patch   # or minor, major
```

**Post-bump (manual):**

```bash
git commit -am "Release vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```
