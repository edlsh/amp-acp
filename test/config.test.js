import { describe, it, expect } from 'vitest';
import {
  config,
  getAmpSettingsOverridesForMode,
  getToolKind,
  getToolTitle,
  slashCommands,
  toolKindMap,
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

  it('returns Spawn Subagent for Task', () => {
    expect(getToolTitle('Task')).toBe('Spawn Subagent');
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
  it('contains required commands', () => {
    const names = slashCommands.map((c) => c.name);
    expect(names).toContain('plan');
    expect(names).toContain('code');
    expect(names).toContain('yolo');
    expect(names).not.toContain('ask');
    expect(names).not.toContain('architect');
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
  it('maps commands to modes', () => {
    expect(config.commandToMode.plan).toBe('plan');
    expect(config.commandToMode.code).toBe('default');
    expect(config.commandToMode.yolo).toBe('bypassPermissions');
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
