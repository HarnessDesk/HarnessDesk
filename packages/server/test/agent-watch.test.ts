import assert from 'node:assert/strict'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { AgentWatch } from '../src/agent-watch.js'
import { Client, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * The roster, watched. A change under a root is a notice naming whose Agents
 * changed; a root that is not there yet is watched for; a project is watched
 * only while it is open, and never through a link that leads out of it.
 *
 * These wait on the filesystem's own notifications, so each gives the watch a
 * moment to start listening before it changes anything, and waits for what it
 * expects rather than for a fixed time wherever it can.
 */

const brief = (words: string) => `---\nname: Scout\n---\n${words}\n`
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check: () => boolean, what: string, ms = 3_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await pause(10)
  }
}
const heard = () => {
  const said: (string | null)[] = []
  return { said, changed: (project: string | null) => void said.push(project) }
}

test('a change under a watched root is a notice, and a burst of them is fewer notices than changes', async (t) => {
  const root = tempDir('hd-agent-watch-')
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [root], changed, settleMs: 50 })
  t.after(() => watch.dispose())
  await pause(150)
  await mkdir(join(root, 'scout'))
  for (let n = 0; n < 10; n += 1) await writeFile(join(root, 'scout', 'AGENT.md'), brief(`Look ${n}.`))
  await until(() => said.length > 0, 'a notice')
  await pause(300)
  assert.ok(said.every((one) => one === null), 'a change in this machine’s roster names no project')
  assert.ok(said.length < 10, `${said.length} notices for 11 changes`)
})

test('a root that is not there yet is watched for, and followed once it appears', async (t) => {
  const home = tempDir('hd-agent-watch-')
  const root = join(home, 'agents')
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [root], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  await pause(150)
  await mkdir(join(root, 'scout'), { recursive: true })
  await until(() => said.length > 0, 'the root appearing')
  // Let the watch move onto the new root, then change something inside it.
  await pause(300)
  said.length = 0
  await writeFile(join(root, 'scout', 'AGENT.md'), brief('Look.'))
  await until(() => said.length > 0, 'a change inside the root that appeared')
})

test('a project is watched while it is open, named as it was opened, and not after', async (t) => {
  const project = tempDir('hd-agent-watch-project-')
  await mkdir(join(project, '.harnessdesk', 'agents', 'scout'), { recursive: true })
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])
  await pause(150)
  await writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Look.'))
  await until(() => said.length > 0, 'a notice for the project')
  assert.ok(said.every((one) => one === project))

  await watch.watchProjects([])
  await pause(100)
  said.length = 0
  await writeFile(join(project, '.harnessdesk', 'agents', 'scout', 'AGENT.md'), brief('Look again.'))
  await pause(400)
  assert.deepEqual(said, [], 'a project that is closed is not watched')
})

test("a project's Agent directory that leads out of the project is not watched", async (t) => {
  const root = tempDir('hd-agent-watch-')
  const project = join(root, 'project')
  const elsewhere = join(root, 'elsewhere')
  await mkdir(join(project, '.harnessdesk'), { recursive: true })
  await mkdir(elsewhere)
  await symlink(elsewhere, join(project, '.harnessdesk', 'agents'))
  const { said, changed } = heard()
  const watch = new AgentWatch({ roots: [], changed, settleMs: 30 })
  t.after(() => watch.dispose())
  await watch.watchProjects([project])
  await pause(150)
  await mkdir(join(elsewhere, 'scout'))
  await writeFile(join(elsewhere, 'scout', 'AGENT.md'), brief('Look.'))
  await pause(400)
  assert.deepEqual(said, [])
})

test("through the host: an Agent written into this machine's roster is a notice to every window", async (t) => {
  const harness = await start()
  t.after(() => stop(harness))
  const client = await Client.connect(harness.server)
  t.after(() => client.close())
  await pause(150)
  await mkdir(join(harness.stateDir, 'agents', 'scout'), { recursive: true })
  await writeFile(join(harness.stateDir, 'agents', 'scout', 'AGENT.md'), brief('Look.'))
  await client.until(
    () =>
      client.notifications.some(
        (one) => 'method' in one && one.method === 'agent/changed' && one.params.project === null,
      ),
    3_000,
    'agent/changed',
  )
})
