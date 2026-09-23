import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { ToolResult } from '@harnessdesk/protocol'

import { ToolGateway } from '../src/tool-gateway.js'

/**
 * The gateway's half of caller scoping: a `caller` token on `tools/invoke`
 * reaches the backend, and its absence reaches the backend as its absence.
 * The token's meaning lives in the wiring's map; the gateway only carries it
 * — but if it dropped it here, no map could help.
 */

/**
 * A directory short enough to hold a unix socket.
 *
 * `sun_path` is 104 bytes on macOS and 108 on Linux, and the path is the
 * whole address — so a long `TMPDIR` (a sandbox, a CI workspace, an agent's
 * scratch directory) makes `bind` fail on a name the test composed itself.
 * It does not fail as a refused test: the process dies inside the runtime
 * with a native assertion and the runner reports the file as failed with no
 * failing test in it, which is a long afternoon for whoever meets it. So the
 * test asks for a short home when its own temp directory is too long.
 */
const socketHome = (): string => {
  const room = 104 - '/hd-gateway-XXXXXX/tools.sock'.length
  const preferred = tmpdir()
  return preferred.length <= room ? preferred : '/tmp'
}

const invokeOver = async (
  request: object,
): Promise<{ caller: string | undefined; reply: unknown }> => {
  const dir = await mkdtemp(join(socketHome(), 'hd-gateway-'))
  const socketPath = join(dir, 'tools.sock')
  let seen: string | undefined = 'never-called'
  const gateway = new ToolGateway(socketPath, {
    listTools: () => [],
    invokeByName: async (_namespace, _name, _args, caller): Promise<ToolResult> => {
      seen = caller
      return { ok: true, content: [{ type: 'text', text: 'done' }] }
    },
  })
  gateway.start()
  try {
    const reply = await new Promise<unknown>((resolve, reject) => {
      const socket = connect(socketPath, () => {
        socket.write(`${JSON.stringify({ id: 1, method: 'tools/invoke', params: request })}\n`)
      })
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const line = buffer.indexOf('\n')
        if (line === -1) return
        socket.end()
        resolve(JSON.parse(buffer.slice(0, line)))
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error('gateway did not answer')), 5000).unref()
    })
    return { caller: seen, reply }
  } finally {
    await gateway.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

test('a caller token on tools/invoke reaches the backend', async () => {
  const { caller } = await invokeOver({
    namespace: 'test',
    name: 'ping',
    args: {},
    caller: 'token-123',
  })
  assert.equal(caller, 'token-123')
})

test('a bridge without a token is simply unscoped — never refused', async () => {
  const { caller, reply } = await invokeOver({ namespace: 'test', name: 'ping', args: {} })
  assert.equal(caller, undefined)
  assert.deepEqual(
    (reply as { result?: { ok?: boolean } }).result?.ok,
    true,
    'the old bridge shape still invokes',
  )
})

test('a non-string caller is treated as absent, not passed through', async () => {
  const { caller } = await invokeOver({ namespace: 'test', name: 'ping', args: {}, caller: 42 })
  assert.equal(caller, undefined)
})

test('a caller token on tools/list reaches the backend too, so a per-Seat listing can be scoped', async () => {
  const dir = await mkdtemp(join(socketHome(), 'hd-gateway-'))
  const socketPath = join(dir, 'tools.sock')
  let seen: string | undefined = 'never-called'
  const gateway = new ToolGateway(socketPath, {
    listTools: (caller) => {
      seen = caller
      return []
    },
    invokeByName: async (): Promise<ToolResult> => ({ ok: true, content: [] }),
  })
  gateway.start()
  try {
    await new Promise<unknown>((resolve, reject) => {
      const socket = connect(socketPath, () => {
        socket.write(`${JSON.stringify({ id: 1, method: 'tools/list', params: { caller: 'token-456' } })}\n`)
      })
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const line = buffer.indexOf('\n')
        if (line === -1) return
        socket.end()
        resolve(JSON.parse(buffer.slice(0, line)))
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error('gateway did not answer')), 5000).unref()
    })
    assert.equal(seen, 'token-456')
  } finally {
    await gateway.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * Phase 12's own two verbs: a Seat's approved external MCP servers, listed
 * and called through the very same socket as the desk's own plugin tools —
 * but never through `tools/list`/`tools/invoke`, which stay the desk
 * capability registry's alone. A backend that does not implement them
 * answers "unknown method", never silently drops the call into the wrong
 * universe of tools.
 */
test('mcp/list and mcp/call reach a backend that implements them, scoped by the same caller token', async () => {
  const dir = await mkdtemp(join(socketHome(), 'hd-gateway-'))
  const socketPath = join(dir, 'tools.sock')
  const calls: { readonly caller: string | undefined; readonly server: string; readonly tool: string; readonly args: unknown }[] = []
  const gateway = new ToolGateway(socketPath, {
    listTools: () => [],
    invokeByName: async (): Promise<ToolResult> => ({ ok: true, content: [] }),
    mcpList: (caller) => (caller === 'seat-token' ? [{ name: 'reviewer-tools', server: 'reviewer-tools' }] : []),
    mcpCall: async (caller, server, tool, args) => {
      calls.push({ caller, server, tool, args })
      return caller === 'seat-token' && server === 'reviewer-tools'
        ? { ok: true, result: 'flagged' }
        : { ok: false, reason: 'refused' }
    },
  })
  gateway.start()
  const send = async (payload: object): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const socket = connect(socketPath, () => socket.write(`${JSON.stringify(payload)}\n`))
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const line = buffer.indexOf('\n')
        if (line === -1) return
        socket.end()
        resolve(JSON.parse(buffer.slice(0, line)))
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error('gateway did not answer')), 5000).unref()
    })
  try {
    const listing = await send({ id: 1, method: 'mcp/list', params: { caller: 'seat-token' } })
    assert.deepEqual(listing, { id: 1, result: { tools: [{ name: 'reviewer-tools', server: 'reviewer-tools' }] } })

    const ok = await send({
      id: 2,
      method: 'mcp/call',
      params: { caller: 'seat-token', server: 'reviewer-tools', tool: 'flag_issue', args: { line: 1 } },
    })
    assert.deepEqual(ok, { id: 2, result: { ok: true, result: 'flagged' } })

    // A different, unrecognised caller reaches the very same backend method —
    // the socket carries no opinion of its own about who may call what.
    const refused = await send({
      id: 3,
      method: 'mcp/call',
      params: { caller: 'someone-else', server: 'reviewer-tools', tool: 'flag_issue', args: {} },
    })
    assert.deepEqual(refused, { id: 3, result: { ok: false, reason: 'refused' } })
    assert.deepEqual(calls.map((c) => c.caller), ['seat-token', 'someone-else'])
  } finally {
    await gateway.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('mcp/list and mcp/call refuse cleanly when the backend does not implement them at all', async () => {
  const dir = await mkdtemp(join(socketHome(), 'hd-gateway-'))
  const socketPath = join(dir, 'tools.sock')
  const gateway = new ToolGateway(socketPath, { listTools: () => [], invokeByName: async () => ({ ok: true, content: [] }) })
  gateway.start()
  const send = async (payload: object): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const socket = connect(socketPath, () => socket.write(`${JSON.stringify(payload)}\n`))
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        const line = buffer.indexOf('\n')
        if (line === -1) return
        socket.end()
        resolve(JSON.parse(buffer.slice(0, line)))
      })
      socket.on('error', reject)
      setTimeout(() => reject(new Error('gateway did not answer')), 5000).unref()
    })
  try {
    assert.deepEqual(await send({ id: 1, method: 'mcp/list', params: {} }), { id: 1, result: { tools: [] } })
    assert.deepEqual(await send({ id: 2, method: 'mcp/call', params: { server: 's', tool: 't', args: {} } }), {
      id: 2,
      result: { ok: false, reason: 'This desk does not offer external MCP servers over this socket.' },
    })
  } finally {
    await gateway.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * The third verb: the standing instruction, for a bridge's `initialize`.
 * Read through the backend at the moment of asking, and nothing at all —
 * not a failure — from a backend with no sentence to give.
 */
test('server/info carries the backend’s instruction, told who is asking, and an empty one when it has none', async () => {
  const ask = async (instructions?: (caller?: string) => string, caller?: string): Promise<unknown> => {
    const dir = await mkdtemp(join(socketHome(), 'hd-gateway-'))
    const socketPath = join(dir, 'tools.sock')
    const gateway = new ToolGateway(socketPath, {
      listTools: () => [],
      invokeByName: async (): Promise<ToolResult> => ({ ok: true, content: [] }),
      ...(instructions ? { instructions } : {}),
    })
    gateway.start()
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const socket = connect(socketPath, () => {
          socket.write(`${JSON.stringify({ id: 1, method: 'server/info', params: caller ? { caller } : {} })}\n`)
        })
        let buffer = ''
        socket.on('data', (chunk) => {
          buffer += chunk.toString()
          const line = buffer.indexOf('\n')
          if (line === -1) return
          socket.end()
          resolve(JSON.parse(buffer.slice(0, line)))
        })
        socket.on('error', reject)
        setTimeout(() => reject(new Error('gateway did not answer')), 5000).unref()
      })
    } finally {
      await gateway.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }
  assert.deepEqual(await ask(() => 'Use the pr_create tool.'), { id: 1, result: { instructions: 'Use the pr_create tool.' } })
  assert.deepEqual(await ask(), { id: 1, result: { instructions: '' } })
  // The bridge's token reaches the backend, which is how an agent whose own
  // bridge carries the sentence is answered nothing here.
  assert.deepEqual(
    await ask((caller) => (caller === 'briefed-already' ? '' : 'Use the pr_create tool.'), 'briefed-already'),
    { id: 1, result: { instructions: '' } },
  )
})
