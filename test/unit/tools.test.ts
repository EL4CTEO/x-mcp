import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { ALL_ACTIONS, ALL_TOOLS, toolsFor } from '../../src/tools/index.ts';
import { TOOLSETS } from '../../src/config.ts';
import { testConfig } from '../helpers/harness.ts';

describe('grouped tool registry', () => {
  it('exposes 10 coherent tools carrying 69 actions', () => {
    expect(ALL_TOOLS).toHaveLength(10);
    expect(ALL_ACTIONS).toHaveLength(69);
    expect(new Set(ALL_TOOLS.map((tool) => tool.name)).size).toBe(10);
    expect(new Set(ALL_ACTIONS.map((action) => action.name)).size).toBe(69);

    for (const tool of ALL_TOOLS) {
      expect(tool.name).toMatch(/^x_[a-z]+$/);
      expect(tool.title.length).toBeGreaterThan(3);
      expect(tool.description).toContain('Actions');
      expect(tool.actions.length).toBeGreaterThan(1);
      expect(typeof tool.annotations.readOnlyHint).toBe('boolean');
      expect(tool.inputSchema.action).toBeDefined();
    }
    for (const action of ALL_ACTIONS) {
      expect(action.name).toMatch(/^x_[a-z0-9_]+$/);
      expect(action.action).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(action.description.length).toBeGreaterThan(30);
      expect(typeof action.annotations.readOnlyHint).toBe('boolean');
    }
  });

  it('covers every advertised toolset exactly once', () => {
    expect(ALL_TOOLS.map((tool) => tool.toolset).sort()).toEqual([...TOOLSETS].sort());
  });

  it('produces valid JSON Schema with an action enum per tool', () => {
    for (const tool of ALL_TOOLS) {
      const schema = toJsonSchemaCompat(z.object(tool.inputSchema), { pipeStrategy: 'input' }) as Record<string, unknown>;
      expect(schema.type, tool.name).toBe('object');
      expect(schema.properties, tool.name).toBeTypeOf('object');
      const properties = schema.properties as Record<string, unknown>;
      const action = properties.action as Record<string, unknown>;
      expect(action, tool.name).toBeDefined();
      expect(Array.isArray(action.enum), tool.name).toBe(true);
      expect((action.enum as string[]).length, tool.name).toBe(tool.actions.length);
      if (schema.required) expect(Array.isArray(schema.required)).toBe(true);
    }
  });

  it('keeps the core capabilities addressable through actions', () => {
    const actionsOf = (group: string): string[] =>
      ALL_TOOLS.find((tool) => tool.name === group)?.actions.map((action) => action.action) ?? [];

    expect(actionsOf('x_posts')).toEqual(
      expect.arrayContaining(['create', 'create_thread', 'get', 'get_many', 'search', 'count', 'thread', 'delete']),
    );
    expect(actionsOf('x_timelines')).toEqual(expect.arrayContaining(['home', 'user', 'mentions', 'liked', 'bookmarks']));
    expect(actionsOf('x_users')).toEqual(expect.arrayContaining(['me', 'get', 'get_many', 'followers', 'follow', 'blocked']));
    expect(actionsOf('x_engagement')).toEqual(expect.arrayContaining(['like', 'repost', 'bookmark']));
    expect(actionsOf('x_lists')).toEqual(expect.arrayContaining(['create', 'posts', 'members', 'follow']));
    expect(actionsOf('x_spaces')).toEqual(expect.arrayContaining(['search', 'get', 'posts']));
    expect(actionsOf('x_trends')).toEqual(expect.arrayContaining(['by_location', 'personalized']));
    expect(actionsOf('x_dms')).toEqual(expect.arrayContaining(['send', 'events', 'conversation']));
    expect(actionsOf('x_media')).toEqual(expect.arrayContaining(['upload', 'status', 'view']));
    expect(actionsOf('x_meta')).toEqual(expect.arrayContaining(['auth_status', 'rate_limits', 'usage']));
  });

  it('filters groups by toolset configuration', () => {
    const postsOnly = toolsFor(testConfig({ toolsets: 'posts' }));
    expect(postsOnly).toHaveLength(1);
    expect(postsOnly[0]?.name).toBe('x_posts');
    expect(postsOnly[0]?.actions).toHaveLength(12);

    const withoutDms = toolsFor(testConfig({ disableToolsets: 'dms' }));
    expect(withoutDms).toHaveLength(9);
    expect(withoutDms.some((tool) => tool.toolset === 'dms')).toBe(false);
  });

  it('classifies read-only groups and actions correctly', () => {
    const byName = new Map(ALL_TOOLS.map((tool) => [tool.name, tool]));
    expect(byName.get('x_timelines')?.annotations.readOnlyHint).toBe(true);
    expect(byName.get('x_trends')?.annotations.readOnlyHint).toBe(true);
    expect(byName.get('x_posts')?.annotations.readOnlyHint).toBe(false);

    const posts = byName.get('x_posts');
    const getAction = posts?.actions.find((action) => action.action === 'get');
    const createAction = posts?.actions.find((action) => action.action === 'create');
    expect(getAction?.annotations.readOnlyHint).toBe(true);
    expect(createAction?.annotations.readOnlyHint).toBe(false);
    expect(ALL_ACTIONS.filter((action) => action.annotations.destructiveHint === true).length).toBeGreaterThan(5);
  });
});
