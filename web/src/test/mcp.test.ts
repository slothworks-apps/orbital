import { describe, it, expect } from 'vitest'
import { ApiError } from '../lib/api'
import {
  emptyMcpForm,
  isMcpCommand,
  isMcpFormDirty,
  isSessionNotRunning,
  joinArgs,
  mcpFailure,
  mcpFormFromDefinition,
  mcpRequestBody,
  mcpRowLabels,
  mcpStatusLabel,
  splitArgs,
  validateMcpForm,
} from '../lib/mcp'
import type { McpForm } from '../lib/mcp'

function words(line: string): string[] {
  const result = splitArgs(line)
  if (!result.ok) throw new Error(result.error)
  return result.words
}

describe('splitArgs', () => {
  it('separates on any run of whitespace', () => {
    expect(words('  -y   @scope/server\t--flag value ')).toEqual([
      '-y',
      '@scope/server',
      '--flag',
      'value',
    ])
  })

  it('reads an empty line as no words', () => {
    expect(words('')).toEqual([])
    expect(words('   ')).toEqual([])
  })

  it('groups by single and double quotes, and joins adjacent parts into one word', () => {
    expect(words(`--name 'two words' "and three more" a'b'"c"`)).toEqual([
      '--name',
      'two words',
      'and three more',
      'abc',
    ])
  })

  it('keeps an empty quoted word', () => {
    expect(words(`a '' "" b`)).toEqual(['a', '', '', 'b'])
  })

  it('takes everything inside single quotes literally', () => {
    expect(words(`'a\\b "c" $HOME'`)).toEqual(['a\\b "c" $HOME'])
  })

  it('escapes only " \\ $ and ` inside double quotes', () => {
    expect(words(`"say \\"hi\\" \\\\ \\$X \\n"`)).toEqual(['say "hi" \\ $X \\n'])
  })

  it('escapes any character with a backslash outside quotes', () => {
    expect(words(`a\\ b c\\'d \\"`)).toEqual(['a b', "c'd", '"'])
  })

  it('keeps a trailing backslash', () => {
    expect(words('a\\')).toEqual(['a\\'])
  })

  it('expands nothing', () => {
    expect(words('$HOME ~/x *.ts')).toEqual(['$HOME', '~/x', '*.ts'])
  })

  it('refuses an unterminated quote', () => {
    expect(splitArgs(`--x 'open`).ok).toBe(false)
    expect(splitArgs(`--x "open`).ok).toBe(false)
    expect(splitArgs(`"ends in an escaped quote\\"`).ok).toBe(false)
  })
})

describe('joinArgs', () => {
  it('leaves plain words bare', () => {
    expect(joinArgs(['-y', '@modelcontextprotocol/server-github', '--port=8080'])).toBe(
      '-y @modelcontextprotocol/server-github --port=8080',
    )
  })

  it('round-trips through splitArgs', () => {
    const cases: string[][] = [
      [],
      [''],
      ['two words', 'x'],
      ["it's", '"quoted"', 'back\\slash', '$HOME', '*', '~'],
      ["'", "''", ' ', '\t', 'a\nb'],
      ['--header', 'Authorization: Bearer x'],
    ]
    for (const list of cases) expect(words(joinArgs(list))).toEqual(list)
  })
})

describe('mcpRowLabels', () => {
  it("names Orbital's own server built-in", () => {
    expect(mcpRowLabels({ name: 'orbital', origin: 'dynamic', toggleable: false })).toEqual({
      name: 'orbital',
      origin: 'built-in',
    })
  })

  it("shows a plugin's server by its own name, under the plugin", () => {
    expect(
      mcpRowLabels({
        name: 'plugin:web-testing:playwright',
        plugin: 'web-testing',
        toggleable: true,
      }),
    ).toEqual({
      name: 'playwright',
      origin: 'plugin · web-testing',
    })
  })

  it('keeps a name that only looks like a plugin name whole', () => {
    expect(
      mcpRowLabels({ name: 'plugin:other:x', plugin: 'web-testing', toggleable: true }).name,
    ).toBe('plugin:other:x')
    expect(
      mcpRowLabels({ name: 'plugin:web-testing:', plugin: 'web-testing', toggleable: true }).name,
    ).toBe('plugin:web-testing:')
  })

  it('falls back to no origin chip', () => {
    expect(mcpRowLabels({ name: 'x', toggleable: true }).origin).toBeNull()
  })
})

describe('mcpStatusLabel', () => {
  it("shows a newer CLI's status as its own text", () => {
    expect(mcpStatusLabel('needs-auth')).toBe('NEEDS LOGIN')
    expect(mcpStatusLabel('quarantined')).toBe('QUARANTINED')
  })
})

describe('validateMcpForm', () => {
  const form = (patch: Partial<McpForm>): McpForm => ({
    ...emptyMcpForm(),
    name: 'github',
    command: 'npx',
    ...patch,
  })

  it('passes a complete stdio form', () => {
    expect(validateMcpForm(form({}))).toEqual({})
  })

  it('needs a name without whitespace', () => {
    expect(validateMcpForm(form({ name: '  ' })).name).toBeDefined()
    expect(validateMcpForm(form({ name: 'my server' })).name).toBeDefined()
    expect(validateMcpForm(form({ name: ' padded ' })).name).toBeUndefined()
  })

  it('needs a command for stdio, and an arguments line that splits', () => {
    expect(validateMcpForm(form({ command: ' ' })).command).toBeDefined()
    expect(validateMcpForm(form({ args: `'open` })).args).toBeDefined()
  })

  it('needs an http(s) URL for http and sse, and ignores the stdio fields there', () => {
    expect(validateMcpForm(form({ transport: 'http', url: 'mcp.example.com' })).url).toBeDefined()
    expect(validateMcpForm(form({ transport: 'sse', url: 'ftp://x' })).url).toBeDefined()
    expect(
      validateMcpForm(form({ transport: 'http', url: ' https://x/mcp', command: '', args: `'` })),
    ).toEqual({})
  })
})

describe('mcpRequestBody', () => {
  it("sends only the chosen transport's fields, without keyless rows", () => {
    const body = mcpRequestBody({
      ...emptyMcpForm(),
      name: ' github ',
      command: ' npx ',
      args: `-y "@scope/server name"`,
      env: [
        { key: 'TOKEN', value: ' s3cr3t ' },
        { key: '', value: 'orphan' },
      ],
      headers: [{ key: 'Authorization', value: 'x' }],
    })
    expect(body).toEqual({
      name: 'github',
      scope: 'local',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@scope/server name'],
      env: { TOKEN: ' s3cr3t ' },
    })
  })

  it('builds a remote server from url and headers', () => {
    const body = mcpRequestBody({
      ...emptyMcpForm(),
      name: 'linear',
      scope: 'user',
      transport: 'sse',
      url: 'https://mcp.linear.app/sse ',
      command: 'ignored',
      headers: [{ key: ' X-Workspace ', value: 'acme' }],
    })
    expect(body).toEqual({
      name: 'linear',
      scope: 'user',
      transport: 'sse',
      url: 'https://mcp.linear.app/sse',
      headers: { 'X-Workspace': 'acme' },
    })
  })

  it('round-trips a stored definition through the edit form', () => {
    const definition = {
      name: 'pg',
      scope: 'local' as const,
      transport: 'stdio' as const,
      command: 'node',
      args: ['server.js', '--root', '/path with spaces', "it's"],
      env: { A: '1' },
    }
    expect(mcpRequestBody(mcpFormFromDefinition(definition))).toEqual(definition)
  })
})

describe('isMcpFormDirty', () => {
  it('ignores blank rows and surrounding whitespace', () => {
    const initial = emptyMcpForm()
    expect(
      isMcpFormDirty(
        { ...initial, name: '  ', env: [], headers: [{ key: '', value: '' }] },
        initial,
      ),
    ).toBe(false)
  })

  it('sees a typed value, a picked option and a removed row', () => {
    const initial = mcpFormFromDefinition({
      name: 'gh',
      scope: 'user',
      transport: 'http',
      url: 'https://x',
      headers: { A: 'b' },
    })
    expect(isMcpFormDirty({ ...initial, url: 'https://y' }, initial)).toBe(true)
    expect(isMcpFormDirty({ ...initial, scope: 'local' }, initial)).toBe(true)
    expect(isMcpFormDirty({ ...initial, headers: [{ key: '', value: '' }] }, initial)).toBe(true)
    expect(isMcpFormDirty({ ...initial, env: [{ key: 'X', value: '' }] }, initial)).toBe(true)
  })
})

describe('mcpFailure', () => {
  it("reads a CLI refusal's output and masked command", () => {
    const err = new ApiError(
      JSON.stringify({
        error: 'cli_refused',
        message: 'MCP server github already exists in local config',
        command: 'claude mcp add-json …',
      }),
      502,
    )
    expect(mcpFailure(err)).toEqual({
      status: 502,
      code: 'cli_refused',
      message: 'MCP server github already exists in local config',
      command: 'claude mcp add-json …',
    })
  })

  it('falls back to the code when there is no message', () => {
    expect(mcpFailure(new ApiError(JSON.stringify({ error: 'unknown_server' }), 404)).message).toBe(
      'unknown_server',
    )
  })

  it('keeps a body that is not a JSON object as the message', () => {
    expect(mcpFailure(new ApiError('Bad Gateway', 502))).toEqual({
      status: 502,
      code: null,
      message: 'Bad Gateway',
      command: null,
    })
    expect(mcpFailure(new ApiError('null', 500)).message).toBe('null')
  })

  it('reads a thrown non-API error', () => {
    expect(mcpFailure(new Error('offline')).status).toBeNull()
  })
})

describe('isSessionNotRunning', () => {
  it("is the not_running 409 only, not the restart route's busy one", () => {
    expect(isSessionNotRunning(new ApiError(JSON.stringify({ error: 'not_running' }), 409))).toBe(
      true,
    )
    expect(isSessionNotRunning(new ApiError(JSON.stringify({ error: 'busy' }), 409))).toBe(false)
  })
})

describe('isMcpCommand', () => {
  it('matches the whole message only', () => {
    expect(isMcpCommand(' /mcp ')).toBe(true)
    expect(isMcpCommand('/mcp list')).toBe(false)
    expect(isMcpCommand('/mcpx')).toBe(false)
  })
})
