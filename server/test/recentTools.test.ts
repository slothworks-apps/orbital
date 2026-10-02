import { describe, it, expect } from 'vitest';
import { RecentToolsStore } from '../src/transcript/recentTools.js';

describe('RecentToolsStore', () => {
  describe('summary extraction', () => {
    it('extracts file path for Edit', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Edit', { file_path: '/path/to/file.txt' }, 1000);
      const tools = store.all('s1');
      expect(tools).toHaveLength(1);
      expect(tools[0].summary).toBe('/path/to/file.txt');
    });

    it('extracts file path for Read', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Read', { file_path: '/path/to/file.ts', limit: 100 }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('/path/to/file.ts');
    });

    it('extracts file path for Write', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Write', { file_path: '/path/to/file.md', content: 'x' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('/path/to/file.md');
    });

    it('extracts first line of command for Bash', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Bash', { command: 'npm run test\necho "done"' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('npm run test');
    });

    it('extracts pattern for Grep', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Grep', { pattern: 'export function.*Store' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('export function.*Store');
    });

    it('extracts pattern for Glob', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Glob', { pattern: 'src/**/*.ts' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('src/**/*.ts');
    });

    it('extracts url for WebFetch', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'WebFetch', { url: 'https://example.com/api' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('https://example.com/api');
    });

    it('extracts query for WebSearch', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'WebSearch', { query: 'typescript types' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('typescript types');
    });

    it('extracts description for Agent', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Agent', { description: 'Code reviewer', subagent_type: 'claude' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('Code reviewer');
    });

    it('extracts subagent_type for Agent when description missing', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Agent', { subagent_type: 'code-reviewer' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('code-reviewer');
    });

    it('extracts description for Task', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Task', { description: 'Run tests' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('Run tests');
    });

    it('extracts skill for Skill', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Skill', { skill: 'code-review' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('code-review');
    });

    it('extracts first string arg for MCP tools', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'mcp__github__list_repos', { owner: 'anthropic', limit: 10 }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('anthropic');
    });

    it('returns null for unknown tools', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'UnknownTool', { something: 'value' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBeNull();
    });

    it('truncates long summaries to 80 chars or less with ellipsis', () => {
      const store = new RecentToolsStore();
      const longPath = '/some/very/long/path/that/exceeds/the/eighty/character/limit/for/truncation/file.ts';
      store.record('s1', 'Edit', { file_path: longPath }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary!.length).toBeLessThanOrEqual(80);
      expect(tools[0].summary).toMatch(/…$/);
    });

    it('collapses whitespace in summaries', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Bash', { command: 'npm   run    test\n  echo   "done"' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].summary).toBe('npm run test');
    });
  });

  describe('cap on entries', () => {
    it('keeps at most 30 tool calls per session', () => {
      const store = new RecentToolsStore();
      const sessionId = 's1';
      for (let i = 0; i < 50; i++) {
        store.record(sessionId, 'Bash', { command: `echo ${i}` }, 1000 + i);
      }
      const tools = store.all(sessionId);
      expect(tools).toHaveLength(30);
      // Should keep the last 30, so the earliest should be echo 20
      expect(tools[0].summary).toBe('echo 20');
      expect(tools[29].summary).toBe('echo 49');
    });

    it('maintains time order when capped', () => {
      const store = new RecentToolsStore();
      const sessionId = 's1';
      for (let i = 0; i < 40; i++) {
        store.record(sessionId, 'Bash', { command: `cmd ${i}` }, 1000 + i);
      }
      const tools = store.all(sessionId);
      // Times should be in ascending order
      for (let i = 0; i < tools.length - 1; i++) {
        expect(tools[i].at).toBeLessThanOrEqual(tools[i + 1].at);
      }
    });
  });

  describe('session isolation', () => {
    it('keeps separate tool lists per session', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Bash', { command: 'echo s1' }, 1000);
      store.record('s2', 'Bash', { command: 'echo s2' }, 1000);
      store.record('s1', 'Bash', { command: 'echo s1 again' }, 2000);

      expect(store.all('s1')).toHaveLength(2);
      expect(store.all('s2')).toHaveLength(1);
      expect(store.all('s3')).toHaveLength(0);
    });
  });

  describe('drop', () => {
    it('forgets a session entirely', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'Bash', { command: 'echo test' }, 1000);
      store.record('s2', 'Bash', { command: 'echo test' }, 1000);
      expect(store.all('s1')).toHaveLength(1);

      store.drop('s1');
      expect(store.all('s1')).toHaveLength(0);
      expect(store.all('s2')).toHaveLength(1); // other sessions unaffected
    });
  });

  describe('timestamp', () => {
    it('records tool call timestamps', () => {
      const store = new RecentToolsStore();
      const t1 = Date.now();
      store.record('s1', 'Bash', { command: 'cmd1' }, t1);
      const t2 = Date.now() + 1000;
      store.record('s1', 'Bash', { command: 'cmd2' }, t2);

      const tools = store.all('s1');
      expect(tools[0].at).toBe(t1);
      expect(tools[1].at).toBe(t2);
    });
  });

  describe('tool name', () => {
    it('records tool name', () => {
      const store = new RecentToolsStore();
      store.record('s1', 'CustomTool', { arg: 'value' }, 1000);
      const tools = store.all('s1');
      expect(tools[0].name).toBe('CustomTool');
    });
  });
});
