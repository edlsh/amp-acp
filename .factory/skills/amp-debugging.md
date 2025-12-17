---
name: amp-debugging
description: Debug Amp CLI integration issues
trigger: when user mentions amp errors, spawn failures, or ACP protocol issues
---

## Instructions

When debugging Amp CLI integration issues:

1. **Check AMP_EXECUTABLE environment variable**
   - Verify `AMP_EXECUTABLE` is set or `amp` is in PATH
   - Test with `amp --version`

2. **Review stderr output**
   - Check `logs/` directory for stderr captures
   - Look for spawn errors or permission issues

3. **Verify ACP protocol version compatibility**
   - Current: ACP SDK v0.11.0
   - Check `@agentclientprotocol/sdk` version in package.json

4. **Common issues**
   - `ENOENT`: amp CLI not found - check PATH or set AMP_EXECUTABLE
   - Timeout: increase AMP_ACP_TIMEOUT_MS (default: 600000ms)
   - Permission denied: check amp CLI permissions

5. **Test commands**

   ```bash
   amp --version
   amp --execute --help
   amp threads list
   ```

6. **Environment variables**
   - `AMP_EXECUTABLE`: Path to amp binary
   - `AMP_PREFER_SYSTEM_PATH`: Use system amp instead of npx
   - `AMP_ACP_TIMEOUT_MS`: Prompt timeout (default: 10 min)
   - `AMP_ACP_NESTED_MODE`: `inline` or `separate` tool display
