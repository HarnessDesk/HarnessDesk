import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseMcpList } from '../src/mcp.js'

/**
 * The MCP server listing parser: turns the human-readable output of `claude
 * mcp list` and `cursor-agent mcp list` into the same `McpServer[]` the
 * extension plane produces.
 */

test('parses Claude Code mcp list output', () => {
  const stdout = [
    'Checking MCP server health…',
    '',
    'claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected',
    'stitch: https://stitch.googleapis.com/mcp (HTTP) - ✔ Connected',
    'firecrawl: npx -y firecrawl-mcp - ⏸ Pending approval (run `claude` to approve)',
    '',
  ].join('\n')

  const servers = parseMcpList(stdout)
  assert.equal(servers.length, 3)
  assert.equal(servers[0]!.name, 'claude.ai Google Drive')
  assert.equal(servers[0]!.auth, 'none')
  assert.equal(servers[1]!.name, 'stitch')
  assert.equal(servers[1]!.auth, 'none')
  assert.equal(servers[2]!.name, 'firecrawl')
  assert.equal(servers[2]!.auth, 'needsLogin')
})

test('parses cursor-agent mcp list output', () => {
  const stdout = [
    'chrome-devtools-mathcat: ready',
    'ios-simulator: ready',
    '',
  ].join('\n')

  const servers = parseMcpList(stdout)
  assert.equal(servers.length, 2)
  assert.equal(servers[0]!.name, 'chrome-devtools-mathcat')
  assert.equal(servers[0]!.auth, 'none')
  assert.equal(servers[1]!.name, 'ios-simulator')
  assert.equal(servers[1]!.auth, 'none')
})

test('returns empty for blank output', () => {
  assert.deepEqual(parseMcpList(''), [])
  assert.deepEqual(parseMcpList('\n\n'), [])
})

test('skips unrecognised lines', () => {
  const stdout = [
    'Loading configuration…',
    'chrome-devtools: ready',
    'Some random text without a colon and status',
    '',
  ].join('\n')
  const servers = parseMcpList(stdout)
  assert.equal(servers.length, 1)
  assert.equal(servers[0]!.name, 'chrome-devtools')
})

test('handles failed and disabled statuses', () => {
  const stdout = [
    'broken-server: https://example.com - ✖ Failed (connection refused)',
    'disabled-one: disabled',
  ].join('\n')
  const servers = parseMcpList(stdout)
  assert.equal(servers.length, 2)
  assert.equal(servers[0]!.name, 'broken-server')
  assert.equal(servers[1]!.name, 'disabled-one')
})

test('all returned servers have empty tools and zero resources', () => {
  const servers = parseMcpList('myserver: ready\n')
  assert.deepEqual(servers[0]!.tools, [])
  assert.equal(servers[0]!.resources, 0)
})
