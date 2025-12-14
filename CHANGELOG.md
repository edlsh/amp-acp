# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/edlsh/amp-acp/compare/v0.2.4...HEAD
[0.2.4]: https://github.com/edlsh/amp-acp/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/edlsh/amp-acp/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/edlsh/amp-acp/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/edlsh/amp-acp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/edlsh/amp-acp/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/edlsh/amp-acp/releases/tag/v0.1.0
