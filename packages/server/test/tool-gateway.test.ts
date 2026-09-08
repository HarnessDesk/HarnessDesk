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
