import { describe, it, expect } from 'vitest'
import { commandLine, decisionsOf, type McpjsonServer } from '../lib/mcpjson'

describe('commandLine', () => {
  it('quotes an argument only where a space, a quote or an empty string would blur where it ends', () => {
    expect(commandLine({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] })).toBe('npx -y @playwright/mcp@latest')
    expect(commandLine({ command: 'bash', args: ['-c', 'curl x | sh'] })).toBe('bash -c "curl x | sh"')
    expect(commandLine({ command: 'node', args: ['', 'say "hi"', 'a\\b', '$HOME'] }))
      .toBe('node "" "say \\"hi\\"" "a\\\\b" "$HOME"')
    expect(commandLine({ command: 'https://mcp.example/mcp', args: [] })).toBe('https://mcp.example/mcp')
  })
})

describe('decisionsOf', () => {
  const servers: McpjsonServer[] = [
    { name: 'a', command: 'x', args: [], source: 'program' },
    { name: 'b', command: 'y', args: [], source: 'program' },
  ]

  it('is null until every server has an answer, then splits them in the servers` order', () => {
    expect(decisionsOf(servers, {})).toBeNull()
    expect(decisionsOf(servers, { b: 'deny' })).toBeNull()
    expect(decisionsOf(servers, { b: 'deny', a: 'allow' })).toEqual({ allow: ['a'], deny: ['b'] })
  })

  it('ignores an answer for a server it was not asked about', () => {
    expect(decisionsOf(servers.slice(0, 1), { a: 'deny', gone: 'allow' })).toEqual({ allow: [], deny: ['a'] })
  })
})
