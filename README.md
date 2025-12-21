# ACP adapter for AmpCode

![Screenshot](https://github.com/edlsh/amp-acp/raw/main/img/screenshot.png)

Use [Amp](https://ampcode.com) from [ACP](https://agentclientprotocol.com/)-compatible clients such as [Zed](https://zed.dev).

## Prerequisites

- [Amp CLI](https://ampcode.com) installed and authenticated (`amp login`)
- Node.js (for running the adapter)

## Installation

1. Find your Amp CLI path:

   ```bash
   which amp
   # Example output: /usr/local/bin/amp
   ```

2. Add to your Zed `settings.json` (open with `cmd+,` or `ctrl+,`):

   ```json
   {
     "agent_servers": {
       "Amp": {
         "command": "npx",
         "args": ["-y", "@edlsh/amp-acp@latest"],
         "env": {
           "AMP_EXECUTABLE": "/usr/local/bin/amp",
           "AMP_PREFER_SYSTEM_PATH": "1"
         }
       }
     }
   }
   ```

   _Replace `/usr/local/bin/amp` with the path from step 1._

## How it Works

- Streams Amp's JSON output over ACP protocol
- Renders Amp messages, tool calls, and interactions in Zed's agent panel
- Tool permissions are handled by Amp (no additional configuration needed)
- Subagent/Oracle tool calls are displayed inline under the parent task
- Slash commands (`/plan`, `/code`, `/yolo`) for mode switching

## Environment Variables

| Variable                 | Description                                                                                     | Default           |
| ------------------------ | ----------------------------------------------------------------------------------------------- | ----------------- |
| `AMP_EXECUTABLE`         | Path to Amp CLI binary                                                                          | `amp`             |
| `AMP_PREFER_SYSTEM_PATH` | Set to `1` to use system Amp instead of npx version                                             | -                 |
| `AMP_ACP_TIMEOUT_MS`     | Prompt timeout in milliseconds                                                                  | `600000` (10 min) |
| `AMP_ACP_NESTED_MODE`    | How to display subagent tool calls: `inline` (embed in parent) or `separate` (individual cards) | `inline`          |

## Troubleshooting

**Connection fails**: Ensure `amp login` was successful and the CLI is in your `AMP_EXECUTABLE`.

**Slash commands not appearing**: If typing `/` doesn't show commands like `/plan`, `/code`, `/yolo`:

1. Open Zed's ACP logs: `dev: open acp logs` from command palette
2. Verify `available_commands_update` notification appears after `session/new` response
3. Ensure you're using amp-acp v0.2.1+ which fixes the notification ordering issue

## Known Limitations

- **No thread history/continuation**: Zed's ACP client does not support the `loadSession` capability for external agents, so each session starts fresh. Thread history is only available in Amp's native TUI.
- **Oracle & Librarian**: These tools are experimental in Amp and may not render perfectly in ACP clients. Their output is displayed inline, but interactive features or deep linking might be limited compared to the native Amp TUI.

## Credits

Forked from [tao12345666333/amp-acp](https://github.com/tao12345666333/amp-acp).
