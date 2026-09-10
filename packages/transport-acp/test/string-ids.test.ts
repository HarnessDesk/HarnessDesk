import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { AcpConnection } from '../src/index.js'

/**
 * #37: a request from the agent is answered whether its id is a number or a
 * string. JSON-RPC allows both, and a string id fell through to the
 * notification path, where nothing answers, and the agent waited forever.
 */
test('a request from the agent with a string id is answered, with that id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'harnessdesk-ids-'))
  const agent = join(dir, 'agent.mjs')
  // Asks twice, once with each kind of id, and writes what it is told back on stderr.
  await writeFile(
    agent,
    [
      "import { createInterface } from 'node:readline'",
      "const ask = (id) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 's-1' } }) + '\\n')",
      "createInterface({ input: process.stdin }).on('line', (line) => process.stderr.write('answer ' + line + '\\n'))",
      "ask('req-1')",
      'ask(7)',
      'setTimeout(() => process.exit(0), 5000)',
    ].join('\n'),
  )
  const answers = new Map<unknown, unknown>()
  const asked: string[] = []
  const notified: string[] = []
  const connection = new AcpConnection({
    command: process.execPath,
    args: [agent],
    onRequest: async (method) => {
      asked.push(method)
      return { outcome: 'allowed' }
    },
    onNotification: (method) => notified.push(method),
    onStderr: (line) => {
      if (!line.startsWith('answer ')) return
      const answer = JSON.parse(line.slice('answer '.length)) as { id?: unknown }
      answers.set(answer.id, answer)
    },
  })
  try {
    await connection.start()
    // Generous, because a loaded machine is slow to boot the child; the answers come in milliseconds.
    for (let i = 0; i < 500 && !(answers.has('req-1') && answers.has(7)); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.deepEqual(answers.get('req-1'), { jsonrpc: '2.0', id: 'req-1', result: { outcome: 'allowed' } })
    assert.deepEqual(answers.get(7), { jsonrpc: '2.0', id: 7, result: { outcome: 'allowed' } }, 'the control: a number id')
    assert.deepEqual(asked, ['session/request_permission', 'session/request_permission'])
    assert.deepEqual(notified, [], 'neither was read as a notification')
  } finally {
    await connection.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
