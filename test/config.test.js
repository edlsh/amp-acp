import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  config,
  getAmpSettingsOverridesForMode,
  getToolKind,
  getToolTitle,
  slashCommands,
  toolKindMap,
  buildAmpOptions,
} from '../src/config.js';

describe('getToolKind', () => {
  it('returns read for Read tool', () => {
    expect(getToolKind('Read')).toBe('read');
  });

  it('returns search for search tools', () => {
    expect(getToolKind('Grep')).toBe('search');
    expect(getToolKind('glob')).toBe('search');
    expect(getToolKind('finder')).toBe('search');
    expect(getToolKind('read_plan')).toBe('search');
  });

  it('returns fetch for web tools', () => {
    expect(getToolKind('web_search')).toBe('fetch');
    expect(getToolKind('read_web_page')).toBe('fetch');
  });

  it('returns edit for edit tools', () => {
    expect(getToolKind('edit_file')).toBe('edit');
    expect(getToolKind('create_file')).toBe('edit');
    expect(getToolKind('undo_edit')).toBe('edit');
    expect(getToolKind('edit_plan')).toBe('edit');
  });

  it('returns execute for execution tools', () => {
    expect(getToolKind('Bash')).toBe('execute');
    expect(getToolKind('Task')).toBe('execute');
  });

  it('returns think for oracle', () => {
    expect(getToolKind('oracle')).toBe('think');
  });

  it('returns fetch for MCP tools', () => {
    expect(getToolKind('mcp__server__tool')).toBe('fetch');
    expect(getToolKind('mcp__exa__search')).toBe('fetch');
  });

  it('returns other for unknown tools', () => {
    expect(getToolKind('unknown_tool')).toBe('other');
    expect(getToolKind('some_custom_thing')).toBe('other');
  });

  it('handles null/undefined', () => {
    expect(getToolKind(null)).toBe('other');
    expect(getToolKind(undefined)).toBe('other');
  });

  it('only returns ACP spec-compliant values', () => {
    const validKinds = [
      'read',
      'edit',
      'delete',
      'move',
      'search',
      'execute',
      'think',
      'fetch',
      'switch_mode',
      'other',
    ];

    // Test all mapped tools
    for (const [_tool, kind] of Object.entries(toolKindMap)) {
      expect(validKinds).toContain(kind);
    }

    // Test dynamic mappings
    expect(validKinds).toContain(getToolKind('mcp__any__thing'));
    expect(validKinds).toContain(getToolKind('random_unknown'));
  });
});

describe('getToolTitle', () => {
  it('returns tool name by default', () => {
    expect(getToolTitle('Read')).toBe('Read');
    expect(getToolTitle('Bash')).toBe('Bash');
  });

  it('returns Oracle for oracle tool', () => {
    expect(getToolTitle('oracle')).toBe('Oracle');
  });

  it('returns Task for Task tool without description', () => {
    expect(getToolTitle('Task')).toBe('Task');
  });

  it('returns description for Task tool with input', () => {
    expect(getToolTitle('Task', null, { description: 'Explore codebase architecture' })).toBe(
      'Explore codebase architecture'
    );
  });

  it('returns TaskOutput for TaskOutput tool', () => {
    expect(getToolTitle('TaskOutput')).toBe('TaskOutput');
  });

  it('formats MCP tool names', () => {
    expect(getToolTitle('mcp__exa__search')).toBe('MCP: exa.search');
    expect(getToolTitle('mcp__server__tool__name')).toBe('MCP: server.tool.name');
  });

  it('adds subagent prefix when parentToolUseId is provided', () => {
    expect(getToolTitle('Read', 'parent-123')).toBe('[Subagent] Read');
    expect(getToolTitle('oracle', 'parent-456')).toBe('[Subagent] Oracle');
    expect(getToolTitle('mcp__exa__search', 'parent-789')).toBe('[Subagent] MCP: exa.search');
  });

  it('handles null/undefined', () => {
    expect(getToolTitle(null)).toBe('Unknown');
    expect(getToolTitle(undefined)).toBe('Unknown');
  });
});

describe('slashCommands', () => {
  it('contains mode commands', () => {
    const names = slashCommands.map((c) => c.name);
    expect(names).toContain('plan');
    expect(names).toContain('code');
    expect(names).toContain('yolo');
  });

  it('contains agent commands', () => {
    const names = slashCommands.map((c) => c.name);
    expect(names).toContain('oracle');
    expect(names).toContain('librarian');
    expect(names).toContain('task');
    expect(names).toContain('parallel');
    expect(names).toContain('web');
  });

  it('has valid structure', () => {
    for (const cmd of slashCommands) {
      expect(cmd).toHaveProperty('name');
      expect(cmd).toHaveProperty('description');
      expect(typeof cmd.name).toBe('string');
      expect(typeof cmd.description).toBe('string');
    }
  });
});

describe('config.commandToMode', () => {
  it('maps mode commands to modes', () => {
    expect(config.commandToMode.plan).toBe('plan');
    expect(config.commandToMode.code).toBe('default');
    expect(config.commandToMode.yolo).toBe('bypassPermissions');
  });

  it('does not include agent commands', () => {
    expect(config.commandToMode.oracle).toBeUndefined();
    expect(config.commandToMode.librarian).toBeUndefined();
    expect(config.commandToMode.task).toBeUndefined();
  });
});

describe('config.commandToPrompt', () => {
  it('maps agent commands to prompt prefixes', () => {
    expect(config.commandToPrompt.oracle).toContain('Oracle');
    expect(config.commandToPrompt.librarian).toContain('Librarian');
    expect(config.commandToPrompt.task).toContain('Task');
    expect(config.commandToPrompt.parallel).toContain('parallel');
    expect(config.commandToPrompt.web).toContain('web_search');
  });

  it('does not include mode commands', () => {
    expect(config.commandToPrompt.plan).toBeUndefined();
    expect(config.commandToPrompt.code).toBeUndefined();
    expect(config.commandToPrompt.yolo).toBeUndefined();
  });
});

describe('getAmpSettingsOverridesForMode', () => {
  it('enables dangerouslyAllowAll for bypassPermissions', () => {
    const overrides = getAmpSettingsOverridesForMode('bypassPermissions');
    expect(overrides.dangerouslyAllowAll).toBe(true);
    expect(overrides.prependPermissions).toEqual([]);
    expect(overrides.disableTools).toEqual([]);
  });

  it('allows edit tools for acceptEdits', () => {
    const overrides = getAmpSettingsOverridesForMode('acceptEdits');
    expect(overrides.dangerouslyAllowAll).toBe(false);
    expect(overrides.prependPermissions).toEqual(
      expect.arrayContaining([
        { tool: 'edit_file', action: 'allow' },
        { tool: 'create_file', action: 'allow' },
      ])
    );
  });

  it('rejects mutating tools and disables builtin mutators for plan', () => {
    const overrides = getAmpSettingsOverridesForMode('plan');
    expect(overrides.dangerouslyAllowAll).toBe(false);
    expect(overrides.prependPermissions).toEqual(
      expect.arrayContaining([
        { tool: 'Bash', action: 'reject' },
        { tool: 'edit_file', action: 'reject' },
      ])
    );
    expect(overrides.disableTools).toEqual(expect.arrayContaining(['builtin:Bash', 'builtin:edit_file']));
  });

  it('defaults to non-dangerous settings for unknown mode IDs', () => {
    const overrides = getAmpSettingsOverridesForMode('unknown-mode');
    expect(overrides.dangerouslyAllowAll).toBe(false);
    expect(overrides.prependPermissions).toEqual([]);
    expect(overrides.disableTools).toEqual([]);
  });
});

describe('config.backend', () => {
  let originalBackend;

  beforeEach(() => {
    originalBackend = config.backend;
  });

  afterEach(() => {
    config.backend = originalBackend;
  });

  it('defaults to cli', () => {
    // Reset to ensure we test the default
    delete process.env.AMP_ACP_BACKEND;
    expect(config.backend).toBe('cli');
  });

  it('can be set to sdk', () => {
    config.backend = 'sdk';
    expect(config.backend).toBe('sdk');
  });
});

describe('config.sdkEnabled', () => {
  let originalBackend;

  beforeEach(() => {
    originalBackend = config.backend;
  });

  afterEach(() => {
    config.backend = originalBackend;
  });

  it('returns true when backend is sdk', () => {
    config.backend = 'sdk';
    expect(config.sdkEnabled).toBe(true);
  });

  it('returns false when backend is cli', () => {
    config.backend = 'cli';
    expect(config.sdkEnabled).toBe(false);
  });

  it('returns false for unknown backend values', () => {
    config.backend = 'unknown';
    expect(config.sdkEnabled).toBe(false);
  });
});

describe('buildAmpOptions', () => {
  it('returns default options when no params provided', () => {
    const options = buildAmpOptions();

    expect(options.cwd).toBe(process.cwd());
    expect(options.dangerouslyAllowAll).toBe(false);
    expect(options.toolbox).toBeUndefined();
    expect(options.prependPermissions).toBeUndefined();
  });

  it('uses provided cwd', () => {
    const options = buildAmpOptions({ cwd: '/custom/path' });

    expect(options.cwd).toBe('/custom/path');
  });

  it('enables dangerouslyAllowAll for bypassPermissions mode', () => {
    const options = buildAmpOptions({ modeId: 'bypassPermissions' });

    expect(options.dangerouslyAllowAll).toBe(true);
    expect(options.toolbox).toBeUndefined();
  });

  it('does not include toolbox for plan mode (SDK limitation)', () => {
    // Note: SDK only accepts cwd, dangerouslyAllowAll, toolbox (path string).
    // disableTools and prependPermissions are not supported - SDK reads from settings file.
    const options = buildAmpOptions({ modeId: 'plan' });

    expect(options.dangerouslyAllowAll).toBe(false);
    expect(options.toolbox).toBeUndefined(); // SDK doesn't support toolbox.disableTools
  });

  it('does not include prependPermissions (SDK limitation)', () => {
    // SDK doesn't support prependPermissions - it reads permissions from settings file
    const options = buildAmpOptions({ modeId: 'plan' });
    expect(options.prependPermissions).toBeUndefined();
  });

  it('does not include prependPermissions for acceptEdits mode (SDK limitation)', () => {
    // SDK doesn't support prependPermissions - uses settings file
    const options = buildAmpOptions({ modeId: 'acceptEdits' });

    expect(options.prependPermissions).toBeUndefined();
    expect(options.dangerouslyAllowAll).toBe(false);
  });

  it('falls back to default mode for unknown modeId', () => {
    const options = buildAmpOptions({ modeId: 'unknown' });

    expect(options.dangerouslyAllowAll).toBe(false);
    expect(options.toolbox).toBeUndefined();
    expect(options.prependPermissions).toBeUndefined();
  });
});
