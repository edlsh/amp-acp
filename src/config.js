// Centralized configuration for amp-acp adapter

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const config = {
  // Amp CLI binary path
  ampExecutable: process.env.AMP_EXECUTABLE || 'amp',

  // Whether to strip npx/node_modules paths to prefer system amp
  preferSystemPath: process.env.AMP_PREFER_SYSTEM_PATH === '1',

  // Amp CLI flags for new sessions
  ampFlags: ['--execute', '--stream-json', '--no-notifications'],

  // Prompt timeout in milliseconds (default: 10 minutes)
  timeoutMs: Number(process.env.AMP_ACP_TIMEOUT_MS) || 10 * 60 * 1000,

  // Stale tool call cleanup threshold in milliseconds (default: 30 minutes)
  staleToolTimeoutMs: Number(process.env.AMP_ACP_STALE_TOOL_TIMEOUT_MS) || 30 * 60 * 1000,

  // Terminal lease duration in milliseconds (default: 5 minutes)
  terminalLeaseMs: Number(process.env.AMP_ACP_TERMINAL_LEASE_MS) || 5 * 60 * 1000,

  // Grace period for killing amp process on cancel in milliseconds (default: 2 seconds)
  cancelGraceMs: Number(process.env.AMP_ACP_CANCEL_GRACE_MS) || 2000,

  // Circuit breaker: number of failures before opening (default: 5)
  circuitBreakerThreshold: Number(process.env.AMP_ACP_CIRCUIT_BREAKER_THRESHOLD) || 5,

  // Circuit breaker: time before attempting recovery in milliseconds (default: 30 seconds)
  circuitBreakerResetMs: Number(process.env.AMP_ACP_CIRCUIT_BREAKER_RESET_MS) || 30000,

  // ACP protocol version
  protocolVersion: 1,

  // Nested tool call display mode:
  // - 'flat': emit all tool calls as independent top-level notifications (default, works with all clients)
  // - 'inline': embed child tool calls as consolidated progress in parent's content (requires tool_call_update support)
  // - 'separate': emit child tool calls as separate ACP tool_call notifications with _meta.parentToolCallId
  nestedToolMode: process.env.AMP_ACP_NESTED_MODE || 'flat',

  // Backend mode: 'cli' spawns amp process, 'sdk' uses @sourcegraph/amp-sdk
  backend: process.env.AMP_ACP_BACKEND || 'cli',

  // Slash command to Amp mode mapping
  commandToMode: {
    plan: 'plan',
    code: 'default',
    yolo: 'bypassPermissions',
  },

  // Slash command to prompt prefix mapping (triggers specific tools)
  commandToPrompt: {
    oracle:
      'Use the Oracle tool to help with this task. Consult the Oracle for expert analysis, planning, or debugging:\n\n',
    librarian:
      'Use the Librarian tool to explore and understand code. Ask the Librarian to analyze repositories on GitHub:\n\n',
    task: 'Use the Task tool to spawn a subagent for this multi-step implementation. Provide detailed instructions:\n\n',
    parallel:
      'Spawn multiple Task subagents to work on these independent tasks in parallel. Each task should be self-contained:\n\n',
    web: 'Use web_search and read_web_page tools to find information about:\n\n',
  },

  // Computed property: whether SDK backend is enabled
  get sdkEnabled() {
    return this.backend === 'sdk';
  },
};

// Slash commands exposed to ACP clients
export const slashCommands = [
  // Mode commands (permission control)
  {
    name: 'plan',
    description: 'Switch to read-only analysis mode (disables modifying tools)',
    input: { hint: 'Optional follow-up prompt' },
  },
  {
    name: 'code',
    description: 'Switch to default mode (uses your amp.permissions settings)',
    input: { hint: 'Optional follow-up prompt' },
  },
  {
    name: 'yolo',
    description: 'Bypass all permission prompts (dangerouslyAllowAll)',
    input: { hint: 'Optional follow-up prompt' },
  },

  // Agent commands (trigger specialized tools)
  {
    name: 'oracle',
    description: 'Consult the Oracle for planning, review, or debugging',
    input: { hint: 'What should the Oracle analyze?' },
  },
  {
    name: 'librarian',
    description: 'Ask the Librarian to explore codebases on GitHub',
    input: { hint: 'What repository or code do you want to understand?' },
  },
  {
    name: 'task',
    description: 'Spawn a Task subagent for multi-file implementation',
    input: { hint: 'Describe the task to delegate' },
  },
  {
    name: 'parallel',
    description: 'Run multiple subagents in parallel',
    input: { hint: 'Describe independent tasks to parallelize' },
  },
  {
    name: 'web',
    description: 'Search the web for documentation or information',
    input: { hint: 'What do you want to search for?' },
  },
];

/**
 * Check if a tool name is a file edit/create tool that produces diffs.
 * @param {string} toolName - Tool name from Amp
 * @returns {boolean} - True if this tool produces file modifications
 */
export function isFileEditTool(toolName) {
  return toolName === 'edit_file' || toolName === 'create_file';
}

// Tool name to ACP ToolKind mapping (spec-compliant values only)
// Valid kinds: read, edit, delete, move, search, execute, think, fetch, switch_mode, other
export const toolKindMap = {
  // Read tools
  Read: 'read',

  // Search tools
  Grep: 'search',
  glob: 'search',
  finder: 'search',
  web_search: 'fetch',
  read_web_page: 'fetch',

  // Edit tools
  edit_file: 'edit',
  create_file: 'edit',
  undo_edit: 'edit',
  format_file: 'edit',

  // Delete/Move tools
  delete_file: 'delete',
  move_file: 'move',

  // Execution tools
  Bash: 'execute',
  Task: 'execute',
  TaskOutput: 'read',

  // Thinking/analysis tools
  oracle: 'think',
  todo_read: 'search',
  todo_write: 'edit',

  // Plan tools
  read_plan: 'search',
  edit_plan: 'edit',
};

export function getAmpSettingsOverridesForMode(modeId) {
  switch (modeId) {
    case 'bypassPermissions':
      return {
        dangerouslyAllowAll: true,
        prependPermissions: [],
        disableTools: [],
      };
    case 'acceptEdits':
      return {
        dangerouslyAllowAll: false,
        prependPermissions: [
          { tool: 'create_file', action: 'allow' },
          { tool: 'edit_file', action: 'allow' },
          { tool: 'delete_file', action: 'allow' },
          { tool: 'move_file', action: 'allow' },
          { tool: 'undo_edit', action: 'allow' },
          { tool: 'format_file', action: 'allow' },
        ],
        disableTools: [],
      };
    case 'plan':
      return {
        dangerouslyAllowAll: false,
        prependPermissions: [
          { tool: 'Bash', action: 'reject' },
          { tool: 'create_file', action: 'reject' },
          { tool: 'edit_file', action: 'reject' },
          { tool: 'delete_file', action: 'reject' },
          { tool: 'move_file', action: 'reject' },
          { tool: 'undo_edit', action: 'reject' },
          { tool: 'format_file', action: 'reject' },
        ],
        disableTools: [
          'builtin:Bash',
          'builtin:create_file',
          'builtin:edit_file',
          'builtin:delete_file',
          'builtin:move_file',
          'builtin:undo_edit',
          'builtin:format_file',
        ],
      };
    case 'default':
    default:
      return {
        dangerouslyAllowAll: false,
        prependPermissions: [],
        disableTools: [],
      };
  }
}

/**
 * Get ACP-compliant tool kind for a given tool name
 */
export function getToolKind(name) {
  if (!name) return 'other';
  if (toolKindMap[name]) return toolKindMap[name];
  if (name.startsWith('mcp__')) return 'fetch';
  return 'other';
}

// Tool title formatters: each returns a formatted title or null to use default
const toolTitleFormatters = {
  Read: (input) => (input?.path ? `Read ${shortenPath(input.path)}` : null),
  Grep: (input) => (input?.pattern ? `Grep "${truncate(input.pattern, 30)}"` : null),
  glob: (input) => (input?.filePattern ? `glob ${truncate(input.filePattern, 40)}` : null),
  finder: (input) => (input?.query ? `finder: ${truncate(input.query, 40)}` : null),
  Bash: (input) => (input?.cmd ? `Bash: ${truncate(input.cmd, 50)}` : null),
  edit_file: (input) => (input?.path ? `Edit ${shortenPath(input.path)}` : null),
  create_file: (input) => (input?.path ? `Create ${shortenPath(input.path)}` : null),
  Task: (input) => (input?.description ? truncate(input.description, 50) : 'Task'),
  TaskOutput: () => 'TaskOutput',
  oracle: (input) => (input?.task ? truncate(input.task, 50) : 'Oracle'),
  todo_write: () => 'Update Plan',
  todo_read: () => 'Read Plan',
  web_search: (input) => (input?.query ? `Search: ${truncate(input.query, 40)}` : null),
  read_web_page: (input) => (input?.url ? `Fetch ${truncate(input.url, 50)}` : null),
};

/**
 * Get display title for a tool, including context from input when available
 */
export function getToolTitle(name, parentToolUseId, input) {
  const prefix = parentToolUseId ? '[Subagent] ' : '';
  if (!name) return prefix + 'Unknown';

  const formatter = toolTitleFormatters[name];
  if (formatter) {
    const title = formatter(input);
    if (title) return prefix + title;
  }

  if (name.startsWith('mcp__')) {
    const parts = name.replace('mcp__', '').split('__');
    return prefix + `MCP: ${parts.join('.')}`;
  }

  return prefix + name;
}

/**
 * Shorten a file path for display (show last 2-3 components)
 */
function shortenPath(path) {
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 3) return parts.join('/');
  return '…/' + parts.slice(-2).join('/');
}

/**
 * Truncate string with ellipsis
 */
function truncate(str, maxLen) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

/**
 * Extract file locations from tool input for ACP locations array
 */
export function getToolLocations(name, input) {
  if (!input) return [];

  switch (name) {
    case 'Read':
    case 'edit_file':
    case 'create_file':
    case 'undo_edit':
      if (input.path) {
        const loc = { path: input.path };
        if (input.read_range?.[0]) loc.line = input.read_range[0];
        return [loc];
      }
      break;
    case 'Grep':
      if (input.path) return [{ path: input.path }];
      break;
    case 'Bash':
      if (input.cwd) return [{ path: input.cwd }];
      break;
  }

  return [];
}

// Inline description formatters for child tool embedding
const inlineDescriptionFormatters = {
  Read: (input) => (input?.path ? `Read ${shortenPath(input.path)}` : 'Read'),
  Grep: (input) => (input?.pattern ? `Grep "${truncate(input.pattern, 25)}"` : 'Grep'),
  glob: (input) => (input?.filePattern ? `glob ${truncate(input.filePattern, 30)}` : 'glob'),
  finder: (input) => (input?.query ? `finder: ${truncate(input.query, 30)}` : 'finder'),
  Bash: (input) => (input?.cmd ? `Bash: ${truncate(input.cmd, 40)}` : 'Bash'),
  edit_file: (input) => (input?.path ? `Edit ${shortenPath(input.path)}` : 'edit_file'),
  create_file: (input) => (input?.path ? `Create ${shortenPath(input.path)}` : 'create_file'),
  Task: (input) => (input?.description ? truncate(input.description, 40) : 'Task'),
  TaskOutput: () => 'TaskOutput',
  oracle: (input) => (input?.task ? truncate(input.task, 40) : 'Oracle'),
  web_search: (input) => (input?.query ? `Search: ${truncate(input.query, 30)}` : 'web_search'),
  read_web_page: (input) => (input?.url ? `Fetch ${truncate(input.url, 40)}` : 'read_web_page'),
};

/**
 * Get a short inline description for embedding child tool calls in parent content
 */
export function getInlineToolDescription(name, input) {
  const formatter = inlineDescriptionFormatters[name];
  if (formatter) return formatter(input);

  if (name?.startsWith('mcp__')) {
    const parts = name.replace('mcp__', '').split('__');
    return `MCP: ${parts.join('.')}`;
  }

  return name || 'Unknown';
}

/**
 * Build environment for spawning amp process
 */
export function buildSpawnEnv() {
  const env = { ...process.env };
  if (config.preferSystemPath && env.PATH) {
    // Drop npx/npm-local node_modules/.bin segments
    const separator = process.platform === 'win32' ? ';' : ':';
    const parts = env.PATH.split(separator).filter((p) => !/\bnode_modules\/\.bin\b|\/_npx\//.test(p));
    env.PATH = parts.join(separator);
  }
  return env;
}

/**
 * Build AmpOptions for SDK execute() call.
 *
 * Note: The amp-sdk only accepts a limited set of options:
 * - cwd: string (working directory)
 * - dangerouslyAllowAll: boolean (bypass all permission checks)
 * - toolbox: string (path to custom toolbox directory)
 *
 * User permissions (amp.permissions) and disabled tools (amp.tools.disable) are
 * NOT supported by the SDK - it reads these from the user's settings file directly.
 * Mode-based permission overrides only work for dangerouslyAllowAll.
 *
 * @param {Object} params
 * @param {string} [params.modeId] - Mode identifier (plan, default, bypassPermissions, acceptEdits)
 * @param {string} [params.cwd] - Working directory
 * @param {Object} [params.clientCapabilities] - ACP client capabilities (reserved for future use)
 * @param {Object} [params.userSettings] - Merged user settings (unused - SDK reads settings directly)
 * @returns {Object} AmpOptions object for SDK
 */
export function buildAmpOptions({
  modeId,
  cwd,
  threadId,
  clientCapabilities: _clientCapabilities,
  userSettings: _userSettings,
} = {}) {
  const settings = getAmpSettingsOverridesForMode(modeId || 'default');

  // SDK accepts: cwd, dangerouslyAllowAll, continue (for thread continuation)
  // Permissions and disabled tools are read from user's settings file by SDK
  const options = {
    cwd: cwd || process.cwd(),
    dangerouslyAllowAll: settings.dangerouslyAllowAll,
  };

  // Pass thread ID to continue the conversation (enables persistent memory)
  if (threadId) {
    options.continue = threadId;
  }

  return options;
}

/**
 * Get the default Amp settings file path.
 * @returns {string|null}
 */
export function getDefaultAmpSettingsPath() {
  if (process.env.AMP_SETTINGS_FILE) return process.env.AMP_SETTINGS_FILE;
  const home = os.homedir?.() || process.env.HOME;
  if (!home) return null;
  return path.join(home, '.config', 'amp', 'settings.json');
}

/**
 * Read and parse a JSON file, returning empty object on missing/invalid files.
 * @param {string|null} filePath
 * @param {Object} [logger] - Optional logger for error reporting
 * @returns {Promise<Object>}
 */
export async function readJsonFile(filePath, logger) {
  if (!filePath) return {};
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return {};
    } else if (e instanceof SyntaxError) {
      logger?.error?.('Invalid JSON in Amp settings file', { filePath, error: e.message });
      return {};
    } else {
      logger?.error?.('Failed to read Amp settings file', { filePath, error: e.message, code: e.code });
      return {};
    }
  }
}

/**
 * Load and merge user Amp settings with mode overrides.
 * Reads from ~/.config/amp/settings.json and <cwd>/.amp/settings.json,
 * then applies mode-specific overrides.
 *
 * @param {string} cwd - Working directory
 * @param {string} modeId - Mode identifier
 * @param {Object} [logger] - Optional logger for error reporting
 * @returns {Promise<Object>} Merged settings object
 */
export async function loadMergedAmpSettings(cwd, modeId, logger) {
  const overrides = getAmpSettingsOverridesForMode(modeId);

  const baseSettings = {
    ...(await readJsonFile(getDefaultAmpSettingsPath(), logger)),
    ...(await readJsonFile(path.join(cwd, '.amp', 'settings.json'), logger)),
  };

  const merged = { ...baseSettings };
  merged['amp.dangerouslyAllowAll'] = overrides.dangerouslyAllowAll;

  if (Array.isArray(overrides.prependPermissions) && overrides.prependPermissions.length > 0) {
    const existing = Array.isArray(merged['amp.permissions']) ? merged['amp.permissions'] : [];
    merged['amp.permissions'] = [...overrides.prependPermissions, ...existing];
  }

  if (Array.isArray(overrides.disableTools) && overrides.disableTools.length > 0) {
    const existing = Array.isArray(merged['amp.tools.disable']) ? merged['amp.tools.disable'] : [];
    merged['amp.tools.disable'] = uniqStrings([...existing, ...overrides.disableTools]);
  }

  return merged;
}

function uniqStrings(values) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
