import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { orphanedAtStart } from '../src/lifecycle.js'

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url))

const listenForGateway = async (options: { readonly hold?: Promise<void>; readonly asked?: () => void } = {}): Promise<{ server: Server; path: string }> => {
  const path = join(tmpdir(), `hdt-${randomUUID().slice(0, 8)}.sock`)
  if (existsSync(path)) unlinkSync(path)
  const server = createServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const request = JSON.parse(line) as { id: number; method: string }
        if (request.method === 'server/info') {
          options.asked?.()
          void (options.hold ?? Promise.resolve()).then(() => {
            if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, result: { instructions: 'ready' } })}\n`)
          })
        }
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, resolve)
  })
  return { server, path }
}

const spawnMain = (path: string): ChildProcess => spawn(process.execPath, [MAIN], {
  env: { ...process.env, HD_TOOLS_SOCKET: path },
  stdio: ['pipe', 'pipe', 'ignore'],
})

const readLine = (rl: Interface, timeoutMs = 5_000): Promise<string> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    rl.removeListener('line', onLine)
    reject(new Error('Timed out waiting for MCP response'))
  }, timeoutMs)
  const onLine = (line: string) => {
    clearTimeout(timer)
    resolve(line)
  }
  rl.once('line', onLine)
})

const waitForExit = (proc: ChildProcess, timeoutMs = 4_000): Promise<number | null> => new Promise((resolve, reject) => {
  if (proc.exitCode !== null) return resolve(proc.exitCode)
  const timer = setTimeout(() => {
    proc.removeListener('exit', onExit)
    reject(new Error(`Process ${proc.pid ?? ''} did not exit within ${timeoutMs}ms`))
  }, timeoutMs)
  const onExit = (code: number | null) => {
    clearTimeout(timer)
    resolve(code)
  }
  proc.once('exit', onExit)
})

const waitForGone = async (pid: number, timeoutMs = 4_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.fail(`Process ${pid} still exists after ${timeoutMs}ms`)
}

test('stdin EOF writes the reply still in flight, then exits successfully', async () => {
  let asked!: () => void
  const askedGateway = new Promise<void>((resolve) => { asked = resolve })
  // The gateway never answers on its own: the reply can only come from the drain on EOF.
  const { server, path } = await listenForGateway({ hold: new Promise<void>(() => {}), asked })
  const proc = spawnMain(path)
  const rl = createInterface({ input: proc.stdout! })
  try {
    proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
    await askedGateway
    proc.stdin!.end()
    const response = JSON.parse(await readLine(rl)) as { id: number; result?: { serverInfo?: { name?: string } } }
    assert.equal(response.id, 1)
    assert.equal(response.result?.serverInfo?.name, 'harnessdesk')
    assert.equal(await waitForExit(proc), 0)
  } finally {
    proc.kill()
    rl.close()
    server.close()
    if (existsSync(path)) unlinkSync(path)
  }
})

test('the server stays alive while stdin remains open and its parent is alive', async () => {
  const { server, path } = await listenForGateway()
  const proc = spawnMain(path)
  try {
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(proc.exitCode, null)
    assert.equal(proc.signalCode, null)
  } finally {
    proc.kill()
    server.close()
    if (existsSync(path)) unlinkSync(path)
  }
})

test('parent death exits the server even when another process keeps stdin open', async () => {
  const { server, path } = await listenForGateway()
  const parentSource = `
    const { spawn } = require('node:child_process');
    const { createInterface } = require('node:readline');
    const child = spawn(process.execPath, [${JSON.stringify(MAIN)}], {
      env: { ...process.env, HD_TOOLS_SOCKET: ${JSON.stringify(path)} },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    // Handshake first: a bridge that answered has recorded this process as its parent.
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\\n');
    createInterface({ input: child.stdout }).once('line', () => {
      const keeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: [child.stdin, 'ignore', 'ignore'],
      });
      process.stdout.write(JSON.stringify({ child: child.pid, keeper: keeper.pid }) + '\\n');
    });
    setInterval(() => {}, 1000);
  `
  const parent = spawn(process.execPath, ['-e', parentSource], { stdio: ['ignore', 'pipe', 'ignore'] })
  let childPid: number | undefined
  let keeperPid: number | undefined
  const rl = createInterface({ input: parent.stdout! })
  try {
    const ids = JSON.parse(await readLine(rl)) as { child: number; keeper: number }
    childPid = ids.child
    keeperPid = ids.keeper
    parent.kill('SIGKILL')
    await waitForGone(childPid)
  } finally {
    if (childPid) {
      try { process.kill(childPid, 'SIGKILL') } catch { /* already gone */ }
    }
    if (keeperPid) {
      try { process.kill(keeperPid, 'SIGKILL') } catch { /* already gone */ }
    }
    parent.kill('SIGKILL')
    rl.close()
    server.close()
    if (existsSync(path)) unlinkSync(path)
  }
})

test('only macOS reads pid 1 at start as orphaned: on Linux an agent CLI can itself be pid 1', () => {
  assert.equal(orphanedAtStart(1, 'darwin'), true)
  assert.equal(orphanedAtStart(4242, 'darwin'), false)
  assert.equal(orphanedAtStart(1, 'linux'), false)
})
