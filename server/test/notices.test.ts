import { describe, it, expect } from 'vitest';
import {
  contextReportOf,
  messageFromLocalCommandEntry,
  noticeFromSdkMessage,
  stripLocalCommandWrapper,
} from '../src/transcript/notices.js';
import { entriesToMessages, parseTranscript } from '../src/transcript/parser.js';

/**
 * Recorded from the CLI Orbital ships against (2.1.278 / SDK 0.3.278) by
 * driving the real `query()` with each command and dumping the stream — see
 * `docs/domains/locally-answered-slash-commands.md`. The shape is the whole
 * point of these tests, so the fixtures keep the fields that carry it and
 * abbreviate only the bodies.
 */
function syntheticAssistant(over: Record<string, unknown> = {}) {
  return {
    type: 'assistant',
    session_id: 's1',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      content: [{ type: 'text', text: '## Context Usage\n\n**Model:** claude-fable-5-1' }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    local_command_source: '<local-command-stdout>## Context Usage\n\n**Model:** claude-fable-5-1</local-command-stdout>',
    local_command_run: { command: 'context', args: '' },
    ...over,
  };
}

describe('stripLocalCommandWrapper', () => {
  it('takes the wrapper off and names the stream', () => {
    expect(stripLocalCommandWrapper('<local-command-stdout>hello</local-command-stdout>')).toEqual({
      text: 'hello',
      stream: 'stdout',
    });
  });

  it('reads stderr as its own stream', () => {
    expect(stripLocalCommandWrapper('<local-command-stderr>boom</local-command-stderr>')).toEqual({
      text: 'boom',
      stream: 'stderr',
    });
  });

  it('accepts a block whose closing tag the CLI left off', () => {
    expect(stripLocalCommandWrapper('<local-command-stdout>hello')).toEqual({
      text: 'hello',
      stream: 'stdout',
    });
  });

  it('leaves unwrapped content alone and reports no stream', () => {
    expect(stripLocalCommandWrapper('/status')).toEqual({ text: '/status', stream: null });
  });

  it('keeps interior whitespace, which is the output\'s only structure', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |';
    expect(stripLocalCommandWrapper(`<local-command-stdout>${table}</local-command-stdout>`).text).toBe(table);
  });
});

describe('noticeFromSdkMessage', () => {
  it('turns a synthetic local-command assistant frame into a notice, not a turn', () => {
    const row = noticeFromSdkMessage(syntheticAssistant(), 'id-1');
    expect(row).toEqual({
      id: 'id-1',
      role: 'notice',
      text: '## Context Usage\n\n**Model:** claude-fable-5-1',
      notice: { level: 'notice', command: '/context' },
    });
    // `<synthetic>` is not a model and must never reach the transcript.
    expect(row).not.toHaveProperty('model');
  });

  it('leaves the row unlabelled when the CLI refused the command outright', () => {
    // `/status` and `/permissions` outside a terminal: output, no
    // `local_command_run`.
    const row = noticeFromSdkMessage(
      syntheticAssistant({
        message: {
          role: 'assistant',
          model: '<synthetic>',
          content: [{ type: 'text', text: "/status isn't available in this environment." }],
        },
        local_command_source: "<local-command-stdout>/status isn't available in this environment.</local-command-stdout>",
        local_command_run: undefined,
      }),
      'id-2',
    );
    expect(row?.notice).toEqual({ level: 'notice' });
    expect(row?.text).toBe("/status isn't available in this environment.");
  });

  it('falls back to the wrapper when the frame carries no text blocks', () => {
    const row = noticeFromSdkMessage(
      syntheticAssistant({ message: { role: 'assistant', model: '<synthetic>', content: [] } }),
      'id-3',
    );
    expect(row?.text).toBe('## Context Usage\n\n**Model:** claude-fable-5-1');
  });

  it('reads stderr as a warning', () => {
    const row = noticeFromSdkMessage(
      syntheticAssistant({
        message: { role: 'assistant', model: '<synthetic>', content: [] },
        local_command_source: '<local-command-stderr>it broke</local-command-stderr>',
        local_command_run: { command: 'voice', args: '' },
      }),
      'id-4',
    );
    expect(row?.notice).toEqual({ level: 'warning', command: '/voice' });
  });

  it('leaves an ordinary assistant turn alone', () => {
    expect(
      noticeFromSdkMessage(
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
        'id-5',
      ),
    ).toBeNull();
  });

  it('reads the SDK system subtype that carries local command output', () => {
    expect(
      noticeFromSdkMessage(
        { type: 'system', subtype: 'local_command_output', content: 'recording started', session_id: 's1' },
        'id-6',
      ),
    ).toEqual({ id: 'id-6', role: 'notice', text: 'recording started', notice: { level: 'notice' } });
  });

  it('keeps the level of an informational banner', () => {
    expect(
      noticeFromSdkMessage(
        { type: 'system', subtype: 'informational', content: 'hook blocked the prompt', level: 'warning' },
        'id-7',
      )?.notice,
    ).toEqual({ level: 'warning' });
  });

  it('falls back to info when a banner names a level the SDK does not have', () => {
    expect(
      noticeFromSdkMessage({ type: 'system', subtype: 'informational', content: 'x', level: 'shout' }, 'id-8')
        ?.notice,
    ).toEqual({ level: 'info' });
  });

  it('still ignores every other system subtype', () => {
    for (const subtype of ['init', 'compact_boundary', 'commands_changed', 'task_started']) {
      expect(noticeFromSdkMessage({ type: 'system', subtype, content: 'x' }, 'id')).toBeNull();
    }
  });

  it('drops a frame whose output is empty rather than showing a blank row', () => {
    expect(
      noticeFromSdkMessage({ type: 'system', subtype: 'local_command_output', content: '   \n ' }, 'id'),
    ).toBeNull();
  });

  it('survives junk', () => {
    expect(noticeFromSdkMessage(null, 'id')).toBeNull();
    expect(noticeFromSdkMessage('nope', 'id')).toBeNull();
    expect(noticeFromSdkMessage({ type: 'system', subtype: 'informational', content: 7 }, 'id')).toBeNull();
  });
});

describe('messageFromLocalCommandEntry', () => {
  it('reads the answer the CLI wrote to the transcript file as a notice', () => {
    expect(
      messageFromLocalCommandEntry(
        {
          type: 'system',
          subtype: 'local_command',
          content: '<local-command-stdout>13 MCP server(s): 7 connected.</local-command-stdout>',
          timestamp: '2026-09-23T10:06:49.212Z',
        },
        'u1:0',
      ),
    ).toEqual({
      id: 'u1:0',
      role: 'notice',
      text: '13 MCP server(s): 7 connected.',
      notice: { level: 'notice' },
      timestamp: '2026-09-23T10:06:49.212Z',
    });
  });

  it('reads the command echo back as the user turn it records', () => {
    // `/status` is refused before expansion, so this entry is the only trace
    // of what was typed — there is no `<command-name>` user turn behind it.
    expect(messageFromLocalCommandEntry({ type: 'system', subtype: 'local_command', content: '/status' }, 'u2:0')).toEqual(
      { id: 'u2:0', role: 'user', text: '/status' },
    );
  });

  it('shows unwrapped content that is not a command line as a notice', () => {
    expect(
      messageFromLocalCommandEntry({ type: 'system', subtype: 'local_command', content: 'something happened' }, 'u3:0'),
    ).toEqual({ id: 'u3:0', role: 'notice', text: 'something happened', notice: { level: 'notice' } });
  });

  it('ignores every other system subtype and every non-system entry', () => {
    expect(messageFromLocalCommandEntry({ type: 'system', subtype: 'compact_boundary', content: 'x' }, 'u')).toBeNull();
    expect(messageFromLocalCommandEntry({ type: 'user', content: 'x' }, 'u')).toBeNull();
  });
});

describe('entriesToMessages with local commands', () => {
  // Trimmed from a real transcript: the `/context` expansion writes a user
  // turn and one wrapped answer; `/status` writes an echo and an answer.
  const jsonl = [
    JSON.stringify({
      type: 'user',
      uuid: 'a',
      timestamp: '2026-09-23T10:06:47.000Z',
      message: { role: 'user', content: '<command-name>/context</command-name>\n<command-args></command-args>' },
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'local_command',
      uuid: 'b',
      timestamp: '2026-09-23T10:06:48.000Z',
      level: 'info',
      content: '<local-command-stdout>## Context Usage\n\n| Category | Tokens |\n|---|---|\n| Messages | 1.3k |</local-command-stdout>',
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'local_command',
      uuid: 'c',
      timestamp: '2026-09-23T10:06:49.000Z',
      level: 'info',
      content: '/status',
    }),
    JSON.stringify({
      type: 'system',
      subtype: 'local_command',
      uuid: 'd',
      timestamp: '2026-09-23T10:06:49.100Z',
      level: 'info',
      content: "<local-command-stdout>/status isn't available in this environment.</local-command-stdout>",
    }),
  ].join('\n');

  it('rebuilds a reloaded transcript with the command output in it', () => {
    const messages = entriesToMessages(parseTranscript(jsonl));
    expect(messages.map((m) => m.role)).toEqual(['user', 'notice', 'user', 'notice']);
    expect(messages[1].text).toContain('| Messages | 1.3k |');
    expect(messages[2].text).toBe('/status');
    expect(messages[3].text).toBe("/status isn't available in this environment.");
  });

  it('keeps the markdown table verbatim, newlines and pipes included', () => {
    const messages = entriesToMessages(parseTranscript(jsonl));
    expect(messages[1].text).toBe('## Context Usage\n\n| Category | Tokens |\n|---|---|\n| Messages | 1.3k |');
  });

  it('does not change a transcript with no local commands in it', () => {
    const plain = JSON.stringify({
      type: 'assistant',
      uuid: 'z',
      message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'hi' }] },
    });
    expect(entriesToMessages(parseTranscript(plain))).toEqual([
      { id: 'z:0', role: 'assistant', text: 'hi', timestamp: undefined, model: 'claude-x', uuid: 'z' },
    ]);
  });
});

/**
 * The structured twin as Claude Code 2.1.280 writes it (trimmed from a real
 * transcript: the shape is real, the lists are cut to a few rows each).
 */
function usage(over: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5-5[1m]',
    total_tokens: 108805,
    raw_max_tokens: 1000000,
    percentage: 11,
    categories: [
      { name: 'System prompt', tokens: 2758, kind: 'used' },
      { name: 'MCP tools (deferred)', tokens: 25954, kind: 'deferred' },
      { name: 'Messages', tokens: 84421, kind: 'used' },
      { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
      { name: 'Free space', tokens: 858195, kind: 'free' },
    ],
    mcp_tools: [{ name: 'mcp__atlas__docs_create', server_name: 'atlas', tokens: 286 }],
    memory_files: [{ path: '/Users/me/.claude/CLAUDE.md', type: 'User', tokens: 142 }],
    agents: [{ agent_type: 'code-reviewer', source: 'userSettings', tokens: 92 }],
    skills: [
      { name: 'code-review:code-review', source: 'plugin', plugin_name: 'code-review', tokens: 18 },
      { name: 'dataviz', source: 'built-in', tokens: 482 },
    ],
    ...over,
  };
}

describe('contextReportOf', () => {
  it('reads the twin into camelCase, keeping the CLI order', () => {
    expect(contextReportOf(usage())).toEqual({
      model: 'claude-opus-5-5[1m]',
      totalTokens: 108805,
      rawMaxTokens: 1000000,
      percentage: 11,
      categories: [
        { name: 'System prompt', tokens: 2758, kind: 'used' },
        { name: 'MCP tools (deferred)', tokens: 25954, kind: 'deferred' },
        { name: 'Messages', tokens: 84421, kind: 'used' },
        { name: 'Autocompact buffer', tokens: 33000, kind: 'buffer' },
        { name: 'Free space', tokens: 858195, kind: 'free' },
      ],
      mcpTools: [{ name: 'mcp__atlas__docs_create', serverName: 'atlas', tokens: 286 }],
      memoryFiles: [{ path: '/Users/me/.claude/CLAUDE.md', type: 'User', tokens: 142 }],
      agents: [{ agentType: 'code-reviewer', source: 'userSettings', tokens: 92 }],
      skills: [
        { name: 'code-review:code-review', source: 'plugin', pluginName: 'code-review', tokens: 18 },
        { name: 'dataviz', source: 'built-in', tokens: 482 },
      ],
    });
  });

  it('reads over_limit when it is whole', () => {
    expect(contextReportOf(usage({ over_limit: { tokens_over: 4500, kind: 'compaction_window' } }))?.overLimit).toEqual({
      tokensOver: 4500,
      kind: 'compaction_window',
    });
    expect(contextReportOf(usage({ over_limit: { kind: 'hard_limit' } }))).not.toHaveProperty('overLimit');
  });

  it('drops the report whole when a core number or the categories are missing', () => {
    expect(contextReportOf(usage({ total_tokens: undefined }))).toBeNull();
    expect(contextReportOf(usage({ raw_max_tokens: '1m' }))).toBeNull();
    expect(contextReportOf(usage({ raw_max_tokens: 0 }))).toBeNull();
    expect(contextReportOf(usage({ categories: null }))).toBeNull();
    expect(contextReportOf(null)).toBeNull();
    expect(contextReportOf('report')).toBeNull();
  });

  it('empties a list that is missing or malformed, and keeps the rest', () => {
    const report = contextReportOf(usage({ mcp_tools: 'none', skills: undefined, agents: { a: 1 } }));
    expect(report?.mcpTools).toEqual([]);
    expect(report?.skills).toEqual([]);
    expect(report?.agents).toEqual([]);
    expect(report?.memoryFiles).toHaveLength(1);
  });

  it('skips a row without numeric tokens or a name, and keeps its neighbours', () => {
    const report = contextReportOf(
      usage({
        categories: [
          { name: 'System prompt', tokens: '2.8k', kind: 'used' },
          null,
          { tokens: 12, kind: 'used' },
          { name: 'Messages', tokens: 84421, kind: 'used' },
        ],
        mcp_tools: [{ name: 'mcp__a__b', server_name: 'a' }, { name: 'mcp__a__c', server_name: 'a', tokens: 9 }],
      }),
    );
    expect(report?.categories).toEqual([{ name: 'Messages', tokens: 84421, kind: 'used' }]);
    expect(report?.mcpTools).toEqual([{ name: 'mcp__a__c', serverName: 'a', tokens: 9 }]);
  });

  it('keeps a category of a kind it does not know, as it came', () => {
    const report = contextReportOf(usage({ categories: [{ name: 'Pinned', tokens: 40, kind: 'pinned' }] }));
    expect(report?.categories).toEqual([{ name: 'Pinned', tokens: 40, kind: 'pinned' }]);
  });

  it('works the percentage out when the CLI left it off', () => {
    expect(contextReportOf(usage({ percentage: undefined }))?.percentage).toBe(11);
  });
});

describe('the /context report on a notice', () => {
  it('rides on the SDK frame as context_usage', () => {
    const row = noticeFromSdkMessage(syntheticAssistant({ context_usage: usage() }), 'id-c');
    expect(row?.notice?.command).toBe('/context');
    expect(row?.notice?.contextReport?.totalTokens).toBe(108805);
    // The printout stays: it is the fallback and the dialog's "As text".
    expect(row?.text).toBe('## Context Usage\n\n**Model:** claude-fable-5-1');
  });

  it('rides on the file entry as contextUsage', () => {
    const row = messageFromLocalCommandEntry(
      {
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout>## Context Usage</local-command-stdout>',
        timestamp: '2026-11-19T08:34:42.615Z',
        contextUsage: usage(),
      },
      'u9:0',
    );
    expect(row?.notice?.contextReport?.rawMaxTokens).toBe(1000000);
    expect(row?.timestamp).toBe('2026-11-19T08:34:42.615Z');
  });

  it('leaves the notice as it was when the twin cannot be read', () => {
    expect(noticeFromSdkMessage(syntheticAssistant({ context_usage: { total_tokens: 5 } }), 'id-d')?.notice).toEqual({
      level: 'notice',
      command: '/context',
    });
  });
});
