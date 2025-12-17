# amp-acp Runbooks

Operational procedures and troubleshooting guides for the amp-acp adapter.

## Table of Contents

- [Troubleshooting](#troubleshooting)
- [Release Process](#release-process)
- [Debugging](#debugging)

---

## Troubleshooting

### Amp Process Spawn Failures

**Symptoms**: `ENOENT` error, Amp process fails to start

**Diagnosis**:

```bash
# Check if amp is installed and accessible
which amp
amp --version

# Check AMP_EXECUTABLE environment variable
echo $AMP_EXECUTABLE
```

**Resolution**:

1. Ensure Amp CLI is installed: `npm install -g @anthropic/amp`
2. If using custom path, set `AMP_EXECUTABLE=/path/to/amp`
3. If running via npx, set `AMP_PREFER_SYSTEM_PATH=1` to use system Amp

### Timeout Issues

**Symptoms**: Prompts killed after 10 minutes, incomplete responses

**Diagnosis**:

```bash
# Check current timeout setting
echo $AMP_ACP_TIMEOUT_MS
```

**Resolution**:

1. Increase timeout: `export AMP_ACP_TIMEOUT_MS=1200000` (20 min)
2. For very long operations, consider breaking into smaller prompts

### Connection Drops

**Symptoms**: ACP client disconnects unexpectedly

**Diagnosis**:

- Check stderr logs for connection state changes
- Look for `connection.signal` abort messages

**Resolution**:

1. Ensure stable network connection
2. Check ACP client (Zed) for errors
3. Restart the adapter

### Thread Continuation Failures

**Symptoms**: `session/load` fails, thread history not loading

**Diagnosis**:

```bash
# List available threads
amp threads list

# Check specific thread exists
amp threads markdown T-<uuid>
```

**Resolution**:

1. Verify thread ID format: `T-<uuid>`
2. Ensure thread exists in Amp history
3. Check Amp authentication status

---

## Release Process

### Pre-release Checklist

1. **Update CHANGELOG.md**
   - Move `[Unreleased]` entries to new version section
   - Add release date

2. **Run tests**

   ```bash
   npm test
   npm run lint
   ```

3. **Bump version**

   ```bash
   ./scripts/bump-version.sh patch  # or minor, major
   ```

4. **Commit and tag**

   ```bash
   git commit -am "Release vX.Y.Z"
   git tag vX.Y.Z
   ```

5. **Push**

   ```bash
   git push origin main --tags
   ```

6. **Publish to npm**
   ```bash
   npm publish --access public
   ```

### Rollback Procedure

If a release has critical issues:

1. **Unpublish (within 72 hours)**

   ```bash
   npm unpublish @edlsh/amp-acp@X.Y.Z
   ```

2. **Or deprecate**

   ```bash
   npm deprecate @edlsh/amp-acp@X.Y.Z "Critical bug, use vX.Y.W instead"
   ```

3. **Revert git changes**
   ```bash
   git revert <commit-hash>
   git tag -d vX.Y.Z
   git push origin main --tags
   ```

---

## Debugging

### Enable Verbose Logging

All logging goes to stderr (stdout is reserved for ACP stream):

```bash
# Run with debug output visible
node src/index.js 2>&1 | tee amp-acp.log
```

### Log Locations

- **Runtime logs**: stderr during execution
- **Saved logs**: `logs/` directory (if configured)

### Common Log Patterns

| Pattern                       | Meaning                  |
| ----------------------------- | ------------------------ |
| `[AMP-ACP] Session created`   | New ACP session started  |
| `[AMP-ACP] Spawning amp`      | Amp CLI process starting |
| `[AMP-ACP] Process exited`    | Amp CLI process finished |
| `[AMP-ACP] Connection closed` | ACP client disconnected  |

### Debugging Tool Calls

Tool calls flow through these stages:

1. `tool_use` → `status: "pending"`
2. Immediately → `status: "in_progress"`
3. `tool_result` → `status: "completed"` or `"failed"`

To debug tool call issues, check:

- Tool name matches expected ACP ToolKind
- Content is properly serialized JSON
- Terminal API is used for Bash tools (if client supports)

### Integration Test Debugging

```bash
# Run specific test with verbose output
npm test -- --reporter=verbose test/integration/acp-protocol.test.js

# Run with debugging
node --inspect node_modules/.bin/vitest run
```

---

## Related Resources

- [AGENTS.md](../AGENTS.md) - Architecture and development guide
- [amp-debugging skill](../.factory/skills/amp-debugging.md) - AI agent debugging tips
- [ACP Protocol Docs](https://agentclientprotocol.com/) - Official ACP specification
