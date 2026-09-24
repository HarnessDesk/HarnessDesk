import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { Agents } from '../src/agents.js'
import { AuthoringPlane, CHANGED, type AuthoringHooks } from '../src/authoring/plane.js'
import { TreeQueue } from '../src/flow-update.js'
import { tempDir } from './scratch.js'

const agentSource = (name: string): string => `---\nname: ${name}\nceiling: read\nanswers: [done]\nprefer: [fixture]\n---\n\nDo the ${name} work.\n`
const flowSource = (first: string, second: string, title = 'Start'): string => [
  'version: 2',
  'name: Pair',
  'roles:',
  `  a: { kind: agent, uses: [${first}], grant: read }`,
  `  b: { kind: agent, uses: [${second}], grant: read }`,
  `seed: { role: a, title: ${title} }`,
  'rules:',
  '  - { id: next, on: a, then: { role: b, title: Next } }',
  '',
].join('\n')

const FLOW = '.harnessdesk/flows/pair.yml'
const WRITER = '.harnessdesk/agents/writer/AGENT.md'
const CHECKER = '.harnessdesk/agents/checker/AGENT.md'

const setup = async () => {
  const scratch = tempDir('hd-authoring-save-')
  const project = join(scratch, 'project')
  const home = join(scratch, 'home')
  const builtinAgents = join(scratch, 'builtin-agents')
  const builtinFlows = join(scratch, 'builtin-flows')
  await Promise.all([mkdir(join(project, '.harnessdesk', 'flows'), { recursive: true }), mkdir(home), mkdir(builtinAgents), mkdir(builtinFlows)])
  const roster = new Agents({ user: join(home, 'agents'), builtin: builtinAgents })
  const queue = new TreeQueue()
  const make = (hooks: AuthoringHooks = {}) => new AuthoringPlane({
    home, journal: join(home, 'authoring'), builtinAgents, builtinFlows,
    confine: async () => {}, agents: (root) => roster.list(root), queue, hooks,
  })
  const seedAgents = async () => {
    for (const id of ['writer', 'checker']) {
      await mkdir(join(project, '.harnessdesk', 'agents', id), { recursive: true })
      await writeFile(join(project, '.harnessdesk', 'agents', id, 'AGENT.md'), agentSource(id))
    }
  }
  return { scratch, project, home, make, queue, seedAgents }
}

const journalsIn = async (home: string): Promise<{ written: string[]; state: string }[]> => {
  const dir = join(home, 'authoring', 'transactions')
  const names = await readdir(dir).catch(() => [] as string[])
  return Promise.all(names.filter((name) => name.endsWith('.json')).map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8'))))
}

test('stale preview writes nothing', async () => {
  const { project, make, seedAgents } = await setup()
  await seedAgents()
  await writeFile(join(project, FLOW), flowSource('writer', 'checker'))
  const events: string[] = []
  const plane = make({ prepared: () => { events.push('prepared') }, beforeWrite: (path) => { events.push(`write:${path}`) } })
  const read = await plane.read({ kind: 'flow', origin: 'project', id: 'pair', root: project })
  const preview = await plane.preview({ target: { kind: 'flow', origin: 'project', id: 'pair', root: project }, expected: read.digest, source: flowSource('writer', 'checker', 'Begin') })
  assert.ok(preview.token, JSON.stringify(preview.issues))
  const edited = flowSource('writer', 'checker', 'Edited by hand')
  await writeFile(join(project, FLOW), edited)
  const result = await plane.apply(preview.token!)
  assert.equal(result.state, 'refused')
  assert.equal(result.message, CHANGED)
  assert.deepEqual(events, [])
  assert.equal(await readFile(join(project, FLOW), 'utf8'), edited)
  // A token is spent once: asking again answers the same refusal, and still writes nothing.
  assert.deepEqual(await plane.apply(preview.token!), result)
  assert.deepEqual(events, [])
})

test('writes dependencies before flow and journals each', async () => {
  const { project, home, make } = await setup()
  const events: string[] = []
  const onDisk: Record<string, string[]> = {}
  const plane = make({
    verified: () => { events.push('verified') },
    prepared: async () => { events.push('prepared'); onDisk['prepared'] = (await journalsIn(home))[0]?.written ?? ['missing'] },
    beforeWrite: async (path) => { events.push(`write:${path}`); onDisk[path] = (await journalsIn(home))[0]?.written ?? ['missing'] },
    recorded: (path) => { events.push(`recorded:${path}`) },
  })
  const preview = await plane.preview({
    target: { kind: 'flow', origin: 'project', id: 'pair', root: project },
    expected: null,
    source: flowSource('writer', 'checker'),
    agents: [{ id: 'writer', source: agentSource('writer') }, { id: 'checker', source: agentSource('checker') }],
  })
  assert.ok(preview.token, JSON.stringify(preview.issues))
  assert.deepEqual(preview.edits.map((edit) => [edit.path, edit.before]), [[WRITER, null], [CHECKER, null], [FLOW, null]])
  const result = await plane.apply(preview.token!)
  assert.deepEqual(result, { state: 'applied', written: [WRITER, CHECKER, FLOW], message: 'Saved.' })
  assert.deepEqual(events, [
    'verified', 'prepared',
    `write:${WRITER}`, `recorded:${WRITER}`,
    `write:${CHECKER}`, `recorded:${CHECKER}`,
    `write:${FLOW}`, `recorded:${FLOW}`,
  ])
  // The journal was durable before the first byte, and each checkpoint before the next file.
  assert.deepEqual(onDisk, { prepared: [], [WRITER]: [], [CHECKER]: [WRITER], [FLOW]: [WRITER, CHECKER] })
  assert.equal(await readFile(join(project, FLOW), 'utf8'), flowSource('writer', 'checker'))
  assert.equal(await readFile(join(project, CHECKER), 'utf8'), agentSource('checker'))
  assert.deepEqual((await journalsIn(home)).map((journal) => journal.state), ['done'])
  assert.deepEqual(await plane.pending(), [])
  // Applied once: the same token answers the saved result, and writes nothing again.
  assert.deepEqual(await plane.apply(preview.token!), result)
})

test('journal failure leaves explicit partial and no referring flow', async () => {
  const { project, make } = await setup()
  const writes: string[] = []
  let failed = false
  const plane = make({
    beforeWrite: (path) => { writes.push(path) },
    recorded: () => {
      if (!failed) { failed = true; throw new Error('The save record could not be written.') }
    },
  })
  const preview = await plane.preview({
    target: { kind: 'flow', origin: 'project', id: 'pair', root: project },
    expected: null,
    source: flowSource('writer', 'checker'),
    agents: [{ id: 'writer', source: agentSource('writer') }, { id: 'checker', source: agentSource('checker') }],
  })
  const result = await plane.apply(preview.token!)
  assert.equal(result.state, 'partial')
  assert.deepEqual(result.written, [WRITER])
  assert.match(result.message, /^1 of 3 files were saved before this stopped: The save record could not be written\./)
  assert.match(result.message, /resume this save/)
  assert.deepEqual(writes, [WRITER])
  await assert.rejects(readFile(join(project, CHECKER), 'utf8'), { code: 'ENOENT' })
  await assert.rejects(readFile(join(project, FLOW), 'utf8'), { code: 'ENOENT' })
  assert.equal(await readFile(join(project, WRITER), 'utf8'), agentSource('writer'))
  const pending = await plane.pending()
  assert.equal(pending.length, 1)
  assert.deepEqual(pending[0]!.files, [WRITER, CHECKER, FLOW])
  // The record never claims a file its checkpoint did not reach; resume reads disk for that one.
  assert.deepEqual(pending[0]!.written, [])
  // Nothing new saves over those files until this one is resumed or discarded.
  const blocked = await plane.preview({ target: { kind: 'flow', origin: 'project', id: 'pair', root: project }, expected: null, source: flowSource('writer', 'writer') })
  assert.equal(blocked.token, null)
  assert.ok(blocked.issues.some((one) => /did not finish/.test(one.text)))
})

const PLANE_URL = new URL('../src/authoring/plane.js', import.meta.url).href
const QUEUE_URL = new URL('../src/flow-update.js', import.meta.url).href
const AGENTS_URL = new URL('../src/agents.js', import.meta.url).href

test('fresh process reconciles uncertain file write', async () => {
  const { scratch, project, home, make } = await setup()
  const script = join(scratch, 'crash.mjs')
  await writeFile(script, `
    import { AuthoringPlane } from ${JSON.stringify(PLANE_URL)}
    import { TreeQueue } from ${JSON.stringify(QUEUE_URL)}
    import { Agents } from ${JSON.stringify(AGENTS_URL)}
    import { join } from 'node:path'
    const [project, home, agentsA, agentsB, flow] = JSON.parse(process.argv[2])
    const roster = new Agents({ user: join(home, 'agents'), builtin: join(home, '..', 'builtin-agents') })
    const plane = new AuthoringPlane({
      home, journal: join(home, 'authoring'), builtinAgents: join(home, '..', 'builtin-agents'), builtinFlows: join(home, '..', 'builtin-flows'),
      confine: async () => {}, agents: (root) => roster.list(root), queue: new TreeQueue(),
      // The flow has landed by rename; the process dies before its checkpoint is recorded.
      hooks: { afterWrite: (path) => { if (path === '${FLOW}') process.kill(process.pid, 'SIGKILL') } },
    })
    const preview = await plane.preview({
      target: { kind: 'flow', origin: 'project', id: 'pair', root: project }, expected: null, source: flow,
      agents: [{ id: 'writer', source: agentsA }, { id: 'checker', source: agentsB }],
    })
    if (!preview.token) { console.error(JSON.stringify(preview.issues)); process.exit(3) }
    await plane.apply(preview.token)
    process.exit(4)
  `)
  const child = spawnSync(process.execPath, [script, JSON.stringify([project, home, agentSource('writer'), agentSource('checker'), flowSource('writer', 'checker')])], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(child.signal, 'SIGKILL', `child ended ${child.status} ${child.stderr}`)
  // What the dead process left: both Agents checkpointed, the flow on disk with no checkpoint.
  assert.equal(await readFile(join(project, FLOW), 'utf8'), flowSource('writer', 'checker'))
  const fresh = make()
  const pending = await fresh.pending()
  assert.equal(pending.length, 1)
  assert.deepEqual(pending[0]!.written, [WRITER, CHECKER])
  assert.deepEqual(pending[0]!.files, [WRITER, CHECKER, FLOW])
  const resumed = await fresh.resume(pending[0]!.id)
  assert.equal(resumed.resuming, true)
  assert.ok(resumed.token, JSON.stringify(resumed.issues))
  const result = await fresh.apply(resumed.token!)
  assert.equal(result.state, 'applied', result.message)
  // Nothing written twice, nothing removed: the same two Agents, the same flow, no temporary left behind.
  assert.deepEqual((await readdir(join(project, '.harnessdesk', 'agents'))).sort(), ['checker', 'writer'])
  assert.deepEqual(await readdir(join(project, '.harnessdesk', 'flows')), ['pair.yml'])
  assert.equal(await readFile(join(project, WRITER), 'utf8'), agentSource('writer'))
  assert.equal(await readFile(join(project, FLOW), 'utf8'), flowSource('writer', 'checker'))
  assert.deepEqual(await fresh.pending(), [])
  assert.deepEqual((await journalsIn(home)).map((journal) => journal.state), ['done'])
})

test('swap cannot write outside the selected root', async () => {
  const { scratch, project, make, seedAgents } = await setup()
  await seedAgents()
  const before = flowSource('writer', 'checker')
  await writeFile(join(project, FLOW), before)
  const outside = join(scratch, 'outside')
  await mkdir(join(outside, 'flows'), { recursive: true })
  await mkdir(join(outside, 'agents', 'writer'), { recursive: true })
  // The sentinel holds the very bytes the preview saw, so only the link refusal can stop a write through it.
  await writeFile(join(outside, 'flows', 'pair.yml'), before)
  const plane = make({
    beforeWrite: async (path) => {
      if (path !== FLOW) return
      await rename(join(project, '.harnessdesk'), join(project, 'harnessdesk-moved'))
      await symlink(outside, join(project, '.harnessdesk'))
    },
  })
  const read = await plane.read({ kind: 'flow', origin: 'project', id: 'pair', root: project })
  const preview = await plane.preview({ target: { kind: 'flow', origin: 'project', id: 'pair', root: project }, expected: read.digest, source: flowSource('writer', 'checker', 'Swapped') })
  assert.ok(preview.token, JSON.stringify(preview.issues))
  const result = await plane.apply(preview.token!)
  assert.equal(result.state, 'refused')
  assert.match(result.message, /link/)
  assert.doesNotMatch(result.message, /\/(private|var|tmp|Users)\//)
  assert.equal(await readFile(join(outside, 'flows', 'pair.yml'), 'utf8'), before)
  assert.equal(await readFile(join(project, 'harnessdesk-moved', 'flows', 'pair.yml'), 'utf8'), before)
})

test('two previews cannot overwrite one another', async () => {
  const { project, make, seedAgents } = await setup()
  await seedAgents()
  await writeFile(join(project, FLOW), flowSource('writer', 'checker'))
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let queuedSignal!: () => void
  const queued = new Promise<void>((resolve) => { queuedSignal = resolve })
  let held = false
  let pausedSignal!: () => void
  const paused = new Promise<void>((resolve) => { pausedSignal = resolve })
  const plane = make({
    queued: () => queuedSignal(),
    beforeWrite: async (path) => {
      if (path === FLOW && !held) { held = true; pausedSignal(); await gate }
    },
  })
  const target = { kind: 'flow', origin: 'project', id: 'pair', root: project } as const
  const read = await plane.read(target)
  const first = await plane.preview({ target, expected: read.digest, source: flowSource('writer', 'third', 'First'), agents: [{ id: 'third', source: agentSource('third') }] })
  const second = await plane.preview({ target, expected: read.digest, source: flowSource('checker', 'writer', 'Second') })
  assert.ok(first.token && second.token)
  const firstRun = plane.apply(first.token!)
  // The first save is inside its transaction, its new Agent written, paused just before the flow.
  await paused
  const secondRun = plane.apply(second.token!)
  // Released once the second has either queued behind the first or, unserialized, finished on its own.
  await Promise.race([queued, secondRun])
  release()
  const [one, two] = await Promise.all([firstRun, secondRun])
  assert.equal(one.state, 'applied', one.message)
  assert.deepEqual(two, { state: 'refused', written: [], message: CHANGED })
  assert.equal(await readFile(join(project, FLOW), 'utf8'), flowSource('writer', 'third', 'First'))
})
