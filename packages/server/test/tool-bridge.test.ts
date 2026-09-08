import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

import {
  agentEnvironment,
  defaultToolBridgeEntry,
  packagedPath,
  toolBridgeEntry,
} from '../src/bootstrap.js'

/**
 * The plugin-tool bridge, as the process that actually runs it sees it.
 *
 * The MCP server rides to the agent in `session/new` and the *agent* spawns
 * it, so every assumption this path makes has to hold for an ordinary Node
 * process, not just for the host. That is what the packaged case is about: a
 * path through `app.asar` is a path into an archive, and nothing outside
 * Electron can open one.
 */

test('the bridge that ships in the repository is the one the host hands out', () => {
  const entry = defaultToolBridgeEntry()
  assert.ok(entry.endsWith(join('mcp-tools', 'dist', 'src', 'main.js')), entry)
  assert.ok(existsSync(entry), 'built by `pnpm build:node`, and named by the same path at runtime')
  assert.equal(toolBridgeEntry(), entry, 'outside a package there is nothing to rewrite')
})

test('a packaged bridge is named where it was unpacked, not inside the archive', () => {
  const inside = ['', 'Applications', 'HarnessDesk.app', 'Contents', 'Resources', 'app.asar',
    'node_modules', '@harnessdesk', 'mcp-tools', 'dist', 'src', 'main.js'].join(sep)
  assert.equal(
    packagedPath(inside),
    inside.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`),
    'the agent is not an Electron and cannot read through an asar',
  )
  // Only the archive segment, and only when it is one: a directory that merely
  // contains the letters is left alone.
  const innocent = join(sep, 'src', 'my.app.asar.tools', 'main.js')
  assert.equal(packagedPath(innocent), innocent)
})

test('a bridge that is not installed is a warning, not an MCP server that cannot start', () => {
  const root = tempDir('hd-bridge-')
  assert.equal(toolBridgeEntry(join(root, 'nothing', 'main.js')), null)

  // And when the packaged copy is there, it is the one that is named.
  const unpacked = join(root, 'app.asar.unpacked', 'mcp-tools', 'dist', 'src')
  mkdirSync(unpacked, { recursive: true })
  writeFileSync(join(unpacked, 'main.js'), '')
  const packed = join(root, 'app.asar', 'mcp-tools', 'dist', 'src', 'main.js')
  assert.equal(toolBridgeEntry(packed), join(unpacked, 'main.js'))
})

test('an ACP agent is born knowing where the tool gateway listens', () => {
  // The MCP server the agent receives carries the socket too, but an agent
  // that composes its own tool clients (DeepSeek Harness) never opens that
  // server — ambient env is the only road to a composition-spawned bridge.
  assert.deepEqual(agentEnvironment('/run/tools.sock', undefined), {
    HD_TOOLS_SOCKET: '/run/tools.sock',
  })
  assert.deepEqual(
    agentEnvironment('/run/tools.sock', { NODE_PATH: '/profile/node_modules' }),
    { HD_TOOLS_SOCKET: '/run/tools.sock', NODE_PATH: '/profile/node_modules' },
    'the registry entry keeps its own environment',
  )
  assert.deepEqual(
    agentEnvironment('/run/tools.sock', { HD_TOOLS_SOCKET: '/elsewhere.sock' }),
    { HD_TOOLS_SOCKET: '/elsewhere.sock' },
    'an entry that names its own socket wins over the host default',
  )
})
