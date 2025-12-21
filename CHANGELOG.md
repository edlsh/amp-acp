# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Persistent memory for sessions**: Amp thread IDs are now captured from `session_id` in CLI result messages and SDK messages, enabling automatic conversation continuation
- Thread continuation via SDK `continue` option for subsequent prompts within a session
- Multi-message SDK flow via `executeMultiMessage()` method in SDK backend
- `_getCreateUserMessage()` lazy loader for amp-sdk's `createUserMessage` helper
- ACP Diff Content Type support for file edit tools (`edit_file`, `create_file`)
- `isFileEditTool()` helper in config.js for detecting file modification tools
- Diff content format: `{ type: "diff", path, oldText?, newText }` for Zed accept/reject UI
- ACP Session Load (Thread Continuation): `loadSession: true` capability enables resuming Amp threads
- `loadSession()` method to load existing threads by ID (T-{uuid} format)
- Thread history fetching via `amp threads markdown T-xxx`
- Thread continuation via `amp threads continue T-xxx --execute --stream-json`
- `getThreadHistory()` and `continueThread()` exports in CLI backend
- SDK backend stubs for thread operations (not yet supported by SDK)
- SDK backend support via `@sourcegraph/amp-sdk` (opt-in via `AMP_ACP_BACKEND=sdk`)
- Backend abstraction layer (`CliAmpBackend`, `SdkAmpBackend`) with factory pattern
- `buildAmpOptions()` helper for SDK configuration with mode support
- SDK adapter (`sdk-adapter.js`) for converting SDK messages to CLI-compatible format
- SDK adapter helpers for Terminal/Plan feature parity: `isSdkPlanToolUse()`, `extractPlanFromSdkToolUse()`, `extractSdkTerminalAndPlanActions()`
- Comprehensive test coverage for backends and SDK adapter

### Changed

- Refactored prompt execution to use pluggable backend drivers
- CLI backend now uses circuit breaker pattern for spawn protection
- `loadSession` capability now conditional: only advertised when CLI backend is active (SDK backend doesn't support thread operations yet)
- Pinned `@sourcegraph/amp-sdk` to `^0.1.0` for deterministic builds

### Fixed

- Circuit breaker check now happens before allocating temp files and abort listeners, preventing resource leaks on early return
- SDK backend regression: removed invalid `prependPermissions` and `toolbox.disableTools` from AmpOptions (SDK only accepts `cwd`, `dangerouslyAllowAll`, `toolbox` as path string)

### Known Limitations

- SDK backend does not support per-mode permission/tool overrides (acceptEdits, plan modes) - SDK reads permissions from user's settings file directly. Only `dangerouslyAllowAll` (bypassPermissions mode) is effective via SDK.

## [0.2.9] - 2025-12-21

### Fixed

- Security: Path traversal vulnerability in image temp file handling - malicious mediaType values are now sanitized to alphanumeric characters only
- Resource leak: Temp image files are now created after early return paths (slash commands, circuit breaker) to ensure cleanup
- Failed image attachments now inform the agent via warning text instead of silently dropping context

## [0.2.8] - 2025-12-21

### Added

- Image prompt support: ACP image chunks are now converted to Amp-compatible JSON format and passed to Amp CLI

## [0.2.7] - 2025-12-21

### Removed

- Thread history/continuation support (`loadSession`, `_replayThreadHistory`, `_validateThreadExists`) - Zed's ACP client does not support this capability for external agents
- `ampContinueFlags` config option (no longer needed)
- Thread ID tracking and emission

## [0.2.6] - 2025-12-21

### Added

- New `flat` nested tool display mode (now default) - emits all tool calls as independent top-level notifications for maximum client compatibility
- Improved error logging with context in stream handlers and catch blocks

### Changed

- Default `AMP_ACP_NESTED_MODE` changed from `inline` to `flat` for better client compatibility
- NestedToolTracker now groups items by status (running → failed → completed) with smart collapsing

### Fixed

- Critical bug preventing AMP ACP from loading in certain client configurations
- Child tool results now correctly emit as independent `tool_call_update` notifications in flat mode
- Subagent text messages now display properly in flat mode instead of being suppressed

## [0.2.5] - 2025-12-14

### Changed

- Inline nested tool display now uses consolidated progress cards with dynamic updates
- Parent tool cards show full child tool status list that updates in real-time
- Progress summary shows: running/completed/failed counts (e.g., "2 running, 3 done (3/5)")
- Child tools displayed in execution order with status icons (◐ running, ✓ done, ✗ failed)

## [0.2.4] - 2025-12-14

## [0.2.3] - 2025-12-14

## [0.2.2] - 2025-12-14

## [0.2.1] - 2025-12-14

### Added

- Contextual tool titles showing file paths, commands, and queries (e.g., "Read …/server.js", "Bash: npm test")
- File locations array in tool calls for "follow-along" feature in ACP clients
- Inline nested tool display: subagent/oracle tool calls now appear embedded in parent tool's content
- `AMP_ACP_NESTED_MODE` env var to switch between `inline` (default) and `separate` display modes
- `NestedToolTracker` class for tracking parent-child tool relationships

### Changed

- `getToolTitle()` now accepts tool input to generate descriptive titles

### Fixed

- Slash commands not appearing in Zed ("Available commands: none") due to notification ordering issue
- Slash commands (`/plan`, `/code`, `/yolo`) now correctly appear in Zed's command palette
- Commands now work for loaded/resumed sessions (previously never emitted `available_commands_update`)
- Added idempotency guard and self-healing fallback for command emission

### Previously Added

- Centralized configuration module (`config.js`) with tool kind/title mappings
- Structured logging system (`logger.js`) with namespace-based loggers
- Slash commands support (`/plan`, `/code`, `/yolo`) with mode switching
- Agent Plan updates via `todo_write`/`todo_read` mapping to ACP Plan API
- Terminal API support for Bash tool when client supports `terminal` capability
- Session load / thread continuation via ACP `session/load` using `amp threads continue`
- Thread URL emission via `agent_thought_chunk` on session start
- Tool call status progression: pending → in_progress → completed/failed
- Connection signal handling to abort in-flight prompts on disconnect
- Timeout handling with configurable `AMP_ACP_TIMEOUT_MS` (default 10 min)
- Test suite with Vitest (`config.test.js`, `to-acp.test.js`)
- Versioning system with `scripts/bump-version.sh`

### Changed

- Upgraded `@agentclientprotocol/sdk` from 0.4.8 to 0.11.0
- Enhanced `agentCapabilities` with `loadSession`, `sessionCapabilities`, `mcpCapabilities`
- Improved message conversion in `to-acp.js` with proper Amp JSON schema handling
- Readline events now processed sequentially via promise chain to prevent race conditions
- Global error handlers for unhandled rejections and uncaught exceptions
- Spawn uses `--execute --stream-json --no-notifications` flags

### Fixed

- Race conditions in readline event processing
- Silent crashes from unhandled promise rejections
- PlanEntry schema: use `content` field instead of `title` per ACP spec
- RequestError schema: use integer error codes per JSON-RPC 2.0 spec
- InitializeResponse schema: `mcpCapabilities` must be object `{ http: false, sse: false }`, not null
- InitializeResponse schema: `sessionCapabilities.fork`/`resume` expect objects or null, not booleans

## [0.2.0] - 2025-01-XX

### Added

- Session load / thread continuation via ACP `session/load`
- Thread URL emission via `agent_thought_chunk` on session start
- Support for `amp threads continue` for multi-turn conversations

## [0.1.0] - 2025-01-XX

### Added

- Initial ACP adapter implementation
- Bash tool routing through ACP Terminal API
- Agent Plan updates via `todo_write`/`todo_read`
- Slash commands (`/plan`, `/code`, `/yolo`)
- Tool call status progression (pending → in_progress → completed/failed)
- Connection lifecycle management with abort signal
- Timeout handling for long-running prompts

[Unreleased]: https://github.com/edlsh/amp-acp/compare/v0.2.9...HEAD
[0.2.9]: https://github.com/edlsh/amp-acp/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/edlsh/amp-acp/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/edlsh/amp-acp/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/edlsh/amp-acp/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/edlsh/amp-acp/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/edlsh/amp-acp/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/edlsh/amp-acp/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/edlsh/amp-acp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/edlsh/amp-acp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/edlsh/amp-acp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/edlsh/amp-acp/releases/tag/v0.1.0
