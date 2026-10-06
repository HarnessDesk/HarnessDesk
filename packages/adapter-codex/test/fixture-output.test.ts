import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CodexAppServer } from '@harnessdesk/codex'

test('a fixture request flushes its reply and notices in one write after snapshots', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-fixture-output-'))
  const log = join(dir, 'writes.ndjson')
  const recorder = join(dir, 'recorder.mjs')
  await writeFile(log, '')
  await writeFile(recorder, `import { appendFileSync } from 'node:fs'
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = (chunk, ...args) => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(String(chunk)) + '\\n')
  return write(chunk, ...args)
}
`)
  const server = new CodexAppServer({
    binaryPath: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
    clientInfo: { name: 'fixture-output-test', title: null, version: '1' },
    env: { NODE_OPTIONS: `--import=${recorder}` },
  })
  t.after(async () => { await server.stop(); await rm(dir, { recursive: true, force: true }) })
  await server.start()
  const notice = new Promise<void>((resolve) => server.onNotification((event) => {
    if (event.method === 'warning') resolve()
  }))
  await server.request('thread/start', { cwd: dir })
  await notice
  const writes = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string)
  const reply = writes.find((chunk) => chunk.includes('"result":{"thread"'))
  assert.ok(reply, 'the fixture wrote its thread reply')
  assert.ok(reply.includes('"method":"thread/started"'), 'the start notice shares the reply write')
  assert.ok(reply.includes('TOOLS_DECLARED'), 'the tool notice shares the reply write')
})
