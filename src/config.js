// Centralized configuration for amp-acp adapter

export const config = {
  // Amp CLI binary path
  ampExecutable: process.env.AMP_EXECUTABLE || 'amp',

  // Whether to strip npx/node_modules paths to prefer system amp
  preferSystemPath: process.env.AMP_PREFER_SYSTEM_PATH === '1',

  // Amp CLI flags for new sessions
  ampFlags: ['--execute', '--stream-json', '--no-notifications'],

  // Amp CLI flags appended after 'threads continue <threadId>'
  ampContinueFlags: ['--execute', '--stream-json', '--no-notifications'],

  // Prompt timeout in milliseconds (default: 10 minutes)
  timeoutMs: Number(process.env.AMP_ACP_TIMEOUT_MS) || 10 * 60 * 1000,

  // ACP protocol version
  protocolVersion: 1,

  // Nested tool call display mode:
  // - 'inline': embed child tool calls as text in parent's content (default, best for Zed)
  // - 'separate': emit child tool calls as separate ACP tool_call notifications
  nestedToolMode: process.env.AMP_ACP_NESTED_MODE || 'inline',

  // Slash command to Amp mode mapping
  commandToMode: {
    plan: 'plan',
    code: 'default',
    yolo: 'bypassPermissions',
    ask: 'default',
    architect: 'plan',
  },
};

// Slash commands exposed to ACP clients
export const slashCommands = [
  { name: 'plan', description: 'Switch to plan mode (read-only analysis)', input: { hint: 'Optional follow-up prompt' } },
  { name: 'code', description: 'Switch to code mode (default)', input: { hint: 'Optional follow-up prompt' } },
  { name: 'yolo', description: 'Bypass all permission prompts', input: { hint: 'Optional follow-up prompt' } },
  { name: 'ask', description: 'Switch to default mode (alias for /code)', input: { hint: 'Optional follow-up prompt' } },
  { name: 'architect', description: 'Switch to plan mode (alias for /plan)', input: { hint: 'Optional follow-up prompt' } },
];

// Tool name to ACP ToolKind mapping (spec-compliant values only)
// Valid kinds: read, edit, delete, move, search, execute, think, fetch, switch_mode, other
export const toolKindMap = {
  // Search tools
  Read: 'search',
  Grep: 'search',
  glob: 'search',
  finder: 'search',
  web_search: 'fetch',
  read_web_page: 'fetch',

  // Edit tools
  edit_file: 'edit',
  create_file: 'edit',
  undo_edit: 'edit',

  // Execution tools
  Bash: 'execute',
  Task: 'execute',

  // Thinking/analysis tools
  oracle: 'think',
  todo_read: 'search',
  todo_write: 'edit',
};

/**
 * Get ACP-compliant tool kind for a given tool name
 */
export function getToolKind(name) {
  if (!name) return 'other';
  if (toolKindMap[name]) return toolKindMap[name];
  if (name.startsWith('mcp__')) return 'fetch';
  return 'other';
}

/**
 * Get display title for a tool, including context from input when available
 */
export function getToolTitle(name, parentToolUseId, input) {
  const prefix = parentToolUseId ? '[Subagent] ' : '';
  if (!name) return prefix + 'Unknown';

  // Generate contextual titles based on tool input
  switch (name) {
    case 'Read':
      if (input?.path) return prefix + `Read ${shortenPath(input.path)}`;
      break;
    case 'Grep':
      if (input?.pattern) return prefix + `Grep "${truncate(input.pattern, 30)}"`;
      break;
    case 'glob':
      if (input?.filePattern) return prefix + `glob ${truncate(input.filePattern, 40)}`;
      break;
    case 'finder':
      if (input?.query) return prefix + `finder: ${truncate(input.query, 40)}`;
      break;
    case 'Bash':
      if (input?.cmd) return prefix + `Bash: ${truncate(input.cmd, 50)}`;
      break;
    case 'edit_file':
      if (input?.path) return prefix + `Edit ${shortenPath(input.path)}`;
      break;
    case 'create_file':
      if (input?.path) return prefix + `Create ${shortenPath(input.path)}`;
      break;
    case 'Task':
      if (input?.description) return prefix + `Task: ${truncate(input.description, 40)}`;
      return prefix + 'Spawn Subagent';
    case 'oracle':
      if (input?.task) return prefix + `Oracle: ${truncate(input.task, 40)}`;
      return prefix + 'Oracle';
    case 'todo_write':
      return prefix + 'Update Plan';
    case 'todo_read':
      return prefix + 'Read Plan';
    case 'web_search':
      if (input?.query) return prefix + `Search: ${truncate(input.query, 40)}`;
      break;
    case 'read_web_page':
      if (input?.url) return prefix + `Fetch ${truncate(input.url, 50)}`;
      break;
  }

  // MCP tools
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

/**
 * Get a short inline description for embedding child tool calls in parent content
 */
export function getInlineToolDescription(name, input) {
  switch (name) {
    case 'Read':
      return input?.path ? `Read ${shortenPath(input.path)}` : 'Read';
    case 'Grep':
      return input?.pattern ? `Grep "${truncate(input.pattern, 25)}"` : 'Grep';
    case 'glob':
      return input?.filePattern ? `glob ${truncate(input.filePattern, 30)}` : 'glob';
    case 'finder':
      return input?.query ? `finder: ${truncate(input.query, 30)}` : 'finder';
    case 'Bash':
      return input?.cmd ? `Bash: ${truncate(input.cmd, 40)}` : 'Bash';
    case 'edit_file':
      return input?.path ? `Edit ${shortenPath(input.path)}` : 'edit_file';
    case 'create_file':
      return input?.path ? `Create ${shortenPath(input.path)}` : 'create_file';
    case 'web_search':
      return input?.query ? `Search: ${truncate(input.query, 30)}` : 'web_search';
    case 'read_web_page':
      return input?.url ? `Fetch ${truncate(input.url, 40)}` : 'read_web_page';
    default:
      if (name?.startsWith('mcp__')) {
        const parts = name.replace('mcp__', '').split('__');
        return `MCP: ${parts.join('.')}`;
      }
      return name || 'Unknown';
  }
}

/**
 * Build environment for spawning amp process
 */
export function buildSpawnEnv() {
  const env = { ...process.env };
  if (config.preferSystemPath && env.PATH) {
    // Drop npx/npm-local node_modules/.bin segments
    const separator = process.platform === 'win32' ? ';' : ':';
    const parts = env.PATH.split(separator).filter(
      (p) => !/\bnode_modules\/\.bin\b|\/_npx\//.test(p)
    );
    env.PATH = parts.join(separator);
  }
  return env;
}
