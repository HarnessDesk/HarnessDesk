import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, sep } from 'node:path'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

import {
  agentEnvironment,
  createToolServer,
  defaultToolBridgeEntry,
  packagedPath,
  toolBridgeEntry,
  writeToolLauncher,
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
  // The agent is named too, for the one bridge that will say it: one its
  // own configuration composed, with no conversation's token.
  assert.deepEqual(agentEnvironment('/run/tools.sock', undefined, 'rig-agent'), {
    HD_TOOLS_SOCKET: '/run/tools.sock',
    HD_TOOLS_AGENT: 'rig-agent',
  })
})

test('the launcher sets Electron to Node and preserves the entry path without ambient env', () => {
  const root = tempDir('hd-tool-launcher-')
  const fakeElectron = join(root, 'fake electron')
  writeFileSync(
    fakeElectron,
    '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ mode: process.env.ELECTRON_RUN_AS_NODE, args: process.argv.slice(2) }))\n',
  )
  chmodSync(fakeElectron, 0o755)
  const entry = join(root, "bridge's entry.js")
  writeFileSync(entry, '')
  const launcher = writeToolLauncher(join(root, 'run'), fakeElectron, entry)

  const output = execFileSync(launcher, ['extra argument'], {
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
  })
  assert.deepEqual(JSON.parse(output), {
    mode: '1',
    args: [entry, 'extra argument'],
  })
})

test('the Electron tool server uses a refreshed executable launcher', () => {
  const root = tempDir('hd-tool-server-')
  const socketPath = join(root, 'run', 'tools.sock')
  const entry = join(root, 'bridge.js')
  writeFileSync(entry, '')

  const first = createToolServer(socketPath, entry, join(root, 'run'), {
    electron: true,
    execPath: join(root, 'first electron'),
  })
  assert.ok(first)
  assert.equal(first.command, join(root, 'run', 'hd-mcp-tools'))
  assert.deepEqual(first.args, [])
  assert.deepEqual(first.env, {
    HD_TOOLS_SOCKET: socketPath,
    ELECTRON_RUN_AS_NODE: '1',
  })
  assert.equal(existsSync(first.command), true)
  assert.notEqual(statSync(first.command).mode & 0o111, 0)
  const firstContent = readFileSync(first.command, 'utf8')

  const second = createToolServer(socketPath, entry, join(root, 'run'), {
    electron: true,
    execPath: join(root, "second 'electron"),
  })
  assert.ok(second)
  assert.notEqual(readFileSync(second.command, 'utf8'), firstContent)
  assert.ok(readFileSync(second.command, 'utf8').includes(String.raw`second '\''electron`))
})

test('the Node tool server keeps the direct Electron-free config', () => {
  const root = tempDir('hd-tool-server-node-')
  const socketPath = join(root, 'run', 'tools.sock')
  const entry = join(root, 'bridge.js')
  const execPath = join(root, 'node')

  assert.deepEqual(createToolServer(socketPath, entry, join(root, 'run'), { electron: false, execPath }), {
    name: 'harnessdesk',
    command: execPath,
    args: [entry],
    env: { HD_TOOLS_SOCKET: socketPath },
  })
})

test('a launcher write failure falls back and logs one warning', () => {
  const root = tempDir('hd-tool-server-fallback-')
  const socketPath = join(root, 'run', 'tools.sock')
  const entry = join(root, 'bridge.js')
  mkdirSync(join(root, 'run', 'hd-mcp-tools'), { recursive: true })
  const messages: string[] = []

  assert.deepEqual(createToolServer(socketPath, entry, join(root, 'run'), {
    electron: true,
    execPath: join(root, 'electron'),
    log: (message: string) => messages.push(message),
  }), {
    name: 'harnessdesk',
    command: join(root, 'electron'),
    args: [entry],
    env: { HD_TOOLS_SOCKET: socketPath, ELECTRON_RUN_AS_NODE: '1' },
  })
  assert.equal(messages.length, 1)
})

test("the launcher is the desk's own, even when its socket fell back to the shared temporary directory", () => {
  const root = tempDir('hd-tool-server-own-')
  const elsewhere = tempDir('hd-tool-server-shared-')
  // `toolSocketPath` puts a too-long socket path in the shared temporary
  // directory; the launcher must not follow it there.
  const socketPath = join(elsewhere, 'harnessdesk-0123456789ab.sock')
  const entry = join(root, 'bridge.js')
  writeFileSync(entry, '')
  const server = createToolServer(socketPath, entry, join(root, 'run'), { electron: true, execPath: join(root, 'electron') })
  assert.equal(server.command, join(root, 'run', 'hd-mcp-tools'))
  assert.equal(existsSync(join(elsewhere, 'hd-mcp-tools')), false)
  assert.equal(server.env.HD_TOOLS_SOCKET, socketPath)
})
