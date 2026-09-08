import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyMcpEdit,
  canonicalMcp,
  decodeMcpEntry,
  decodeRawMcpEntry,
  readRawMcpEntry,
  type McpServerSpec,
} from '../src/mcp.js'

/**
 * The codec's contract is "faithful, or refuse" — a field it cannot carry must
 * fail the decode so the copy is refused, never dropped and written as a
 * different server. These are the ways it used to drop instead.
 */

test('a non-string arg refuses the decode rather than dropping the whole args list', () => {
  const raw = JSON.stringify({ command: 'node', args: ['server.js', 8080] })
  assert.equal(decodeRawMcpEntry(raw, 'json', 'db', 'claude'), null)
})

test('a non-string env value refuses the decode rather than dropping the pair', () => {
  const raw = JSON.stringify({ command: 'srv', env: { PORT: 3000, TOKEN: 'abc' } })
  assert.equal(decodeRawMcpEntry(raw, 'json', 'x', 'claude'), null)
})

test('a TOML args array this reader cannot parse refuses rather than dropping args', () => {
  const raw = 'command = "npx"\nargs = ["--filter", "items[0]"]'
  assert.equal(decodeRawMcpEntry(raw, 'toml', 'github', 'codex'), null)
})

test('a TOML env key the encoder would mangle refuses the decode', () => {
  const raw = 'command = "srv"\nenv = { API-KEY = "s3cr3t" }'
  assert.equal(decodeRawMcpEntry(raw, 'toml', 'x', 'codex'), null)
})

test('a stdio server with faithful args and env decodes', () => {
  const raw = 'command = "npx"\nargs = ["-y", "pkg"]\nenv = { TOKEN = "abc" }'
  const spec = decodeRawMcpEntry(raw, 'toml', 'ok', 'codex')
  assert.deepEqual(spec, { name: 'ok', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 'abc' } })
})

test('a server named `constructor` reads back null, not a prototype value', () => {
  const text = JSON.stringify({ mcpServers: { other: { command: 'x' } } })
  assert.equal(readRawMcpEntry(text, 'json', 'mcpServers', 'constructor'), null)
  assert.equal(decodeMcpEntry(text, 'json', 'mcpServers', 'constructor', 'claude'), null)
})

test('a server named `__proto__` is written as an own key, changing the file', () => {
  const spec: McpServerSpec = { name: '__proto__', transport: 'stdio', command: 'x' }
  const next = applyMcpEdit('{}', 'json', 'mcpServers', '__proto__', spec, 'claude')
  const parsed = JSON.parse(next) as { mcpServers: Record<string, unknown> }
  assert.ok(Object.hasOwn(parsed.mcpServers, '__proto__'))
})

test('a TOML table header with a trailing comment is found, so no duplicate is appended', () => {
  const text = '[mcp_servers.linear]  # work account\ncommand = "npx"\n'
  assert.notEqual(readRawMcpEntry(text, 'toml', 'mcp_servers', 'linear'), null)
  const next = applyMcpEdit(text, 'toml', 'mcp_servers', 'linear', {
    name: 'linear',
    transport: 'stdio',
    command: 'npx-2',
  }, 'codex')
  assert.equal(next.match(/\[mcp_servers\.linear\]/g)?.length, 1)
})

test('removing a TOML block keeps the comment that belongs to the next server', () => {
  const text = [
    '[mcp_servers.a]',
    'command = "x"',
    '',
    '# the shared staging server',
    '[mcp_servers.b]',
    'command = "y"',
    '',
  ].join('\n')
  const next = applyMcpEdit(text, 'toml', 'mcp_servers', 'a', null, 'codex')
  assert.match(next, /# the shared staging server/)
  assert.match(next, /\[mcp_servers\.b\]/)
  assert.doesNotMatch(next, /\[mcp_servers\.a\]/)
})

test('the same server spelled in two dialects has one canonical form', () => {
  const claude = decodeRawMcpEntry(
    JSON.stringify({ command: 'npx', args: ['-y', 'srv'], env: { A: '1', B: '2' } }),
    'json',
    'srv',
    'claude',
  )
  const codex = decodeRawMcpEntry('command = "npx"\nargs = ["-y", "srv"]\nenv = { B = "2", A = "1" }', 'toml', 'srv', 'codex')
  assert.ok(claude && codex)
  assert.equal(canonicalMcp(claude), canonicalMcp(codex))
})
