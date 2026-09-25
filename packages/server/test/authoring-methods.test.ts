import assert from 'node:assert/strict'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseClientMessage, ValidationError, type HostMethodName } from '@harnessdesk/protocol'

import { Agents } from '../src/agents.js'
import { AuthoringPlane, COPY_AGENTS_FIRST, MODELS_STAY_HERE } from '../src/authoring/plane.js'
import { TreeQueue } from '../src/flow-update.js'
import { dispatch, type HostContext } from '../src/methods/index.js'
import { tempDir } from './scratch.js'

const ROOT = '/work/project'
const DIGEST = 'a'.repeat(64)
const agent = { kind: 'agent', origin: 'project', id: 'reviewer', root: ROOT }
const flow = { kind: 'flow', origin: 'project', id: 'review-pr', root: ROOT }

const refused = (method: string, params: unknown): void => {
  assert.throws(() => parseClientMessage({ id: 1, method, params }), ValidationError, `${method} ${JSON.stringify(params)}`)
}

test('wire refuses arbitrary paths and forged origins', async () => {
  // Traversal, separators, case and control characters never become an id.
  for (const id of ['../reviewer', 'a/b', 'A', '', 'x\u0000', '.harnessdesk', 'agents\\x']) {
    refused('authoring/read', { target: { ...agent, id } })
    refused('authoring/read', { target: { ...flow, id } })
  }
  // A root is an absolute folder; a relative or control-laden one is refused.
  refused('authoring/read', { target: { ...flow, root: 'project' } })
  refused('authoring/read', { target: { ...flow, root: '/work/\u0007' } })
  // No path, environment, grant or origin rides along on a target or a call.
  refused('authoring/read', { target: { ...agent, path: '/etc/passwd' } })
  refused('authoring/read', { target: agent, path: '/etc/passwd' })
  refused('authoring/save/preview', { target: flow, expected: null, source: 'x', env: { HOME: '/' } })
  refused('authoring/save/preview', { target: flow, expected: null, source: 'x', grant: 'merge' })
  refused('authoring/save/preview', { target: { ...flow, grant: 'merge' }, expected: null, source: 'x' })
  refused('authoring/save/preview', { target: { kind: 'file', origin: 'project', id: 'x', root: ROOT }, expected: null, source: 'x' })
  refused('authoring/read', { target: { kind: 'triggers', origin: 'user', root: ROOT } })
  // A built-in file is read, never written: refused on the wire for every write verb.
  refused('authoring/save/preview', { target: { ...flow, origin: 'builtin' }, expected: null, source: 'x' })
  refused('authoring/agent/patch', { target: { ...agent, origin: 'builtin' }, expected: DIGEST, edit: { key: 'name', value: 'x' } })
  // A patch edits an Agent's row by value: no other field, no flow, no pre-encoded text.
  refused('authoring/agent/patch', { target: flow, expected: DIGEST, edit: { key: 'name', value: 'x' } })
  refused('authoring/agent/patch', { target: agent, expected: DIGEST, edit: { key: 'skills', value: ['x'] } })
  refused('authoring/agent/patch', { target: agent, expected: DIGEST, edit: { key: 'name', value: 'x', encoded: '"x"\nceiling: merge' } })
  refused('authoring/agent/patch', { target: agent, expected: DIGEST, edit: { key: 'ceiling', value: 'root' } })
  refused('authoring/agent/patch', { target: agent, expected: 'not-a-digest', edit: { key: 'name', value: 'x' } })
  // Digests, tokens and record ids are bounded opaque strings.
  refused('authoring/save/preview', { target: flow, expected: 'short', source: 'x' })
  refused('authoring/save/apply', { token: 'x'.repeat(201) })
  refused('authoring/save/apply', { token: 'x', path: '/tmp/y' })
  refused('authoring/save/resume', { id: '../../etc' })
  refused('authoring/save/preview', { target: flow, expected: null, source: 'x', agents: [{ id: '../x', source: 'y' }] })
  refused('authoring/save/preview', { target: flow, expected: null, source: 'x', agents: Array.from({ length: 17 }, (_value, index) => ({ id: `a${index}`, source: 'y' })) })

  // A rendered policy is the right shape before it ever reaches `writeShape`'s own round-trip check.
  refused('authoring/shape/render', { policy: { version: 1 } })
  refused('authoring/shape/render', { policy: { version: 2, name: 'x', inputs: [], roles: [{ id: 'a', kind: 'wizard' }], rules: [], seed: { role: 'a', title: 't' }, messaging: 'board-only', wait: 60 } })
  refused('authoring/shape/render', { policy: { version: 2, name: 'x', inputs: [], roles: [], rules: [], seed: { role: 'a', title: 't' }, messaging: 'shout', wait: 60 } })
  refused('authoring/shape/render', {
    policy: {
      version: 2, name: 'x', inputs: [], rules: [], seed: { role: 'a', title: 't' }, messaging: 'board-only', wait: 60,
      roles: [{ id: 'a', kind: 'agent', uses: ['reviewer'], seats: [], isolate: false, grant: 'root', independentOf: [] }],
    },
  })
  // A trigger draft and a rendered list are exactly the closed vocabulary phase 8 reads.
  refused('authoring/triggers/draft', { id: 'x', on: 'push', opens: { flow: 'a' } })
  refused('authoring/triggers/draft', { id: 'x', on: 'schedule', opens: { flow: 'a', agent: 'b' } })
  refused('authoring/triggers/render', {
    definitions: [{
      id: 'x', on: { kind: 'pull-request', events: ['opened'] }, opens: { flow: 'a' }, goal: ['pr'], again: null,
      dedupe: ['pr'], concurrency: 1, forks: 'sometimes', budget: { usd: 1, rounds: 1, hours: 1, withoutProgress: 1 },
    }],
  })

  // What does parse is handed to the one owner as it was parsed, and nothing refused above ever reaches it.
  const calls: [string, unknown[]][] = []
  const port = new Proxy({}, { get: (_target, name) => async (...args: unknown[]) => { calls.push([String(name), args]); return null } })
  const ctx = { authoring: port } as unknown as HostContext
  const good: [HostMethodName, unknown][] = [
    ['authoring/read', { target: { kind: 'agent', origin: 'builtin', id: 'reviewer' } }],
    ['authoring/agent/patch', { target: agent, expected: DIGEST, edit: { key: 'prefer', value: [{ runtime: 'fixture' }] } }],
    ['authoring/save/preview', { target: { kind: 'triggers', origin: 'project', root: ROOT }, expected: null, source: '' }],
    ['authoring/save/apply', { token: 'token-1' }],
    ['authoring/save/pending', {}],
    ['authoring/save/resume', { id: 'b'.repeat(32) }],
    ['authoring/save/discard', { id: 'b'.repeat(32) }],
    [
      'authoring/shape/render',
      { policy: { version: 2, name: 'x', inputs: [], roles: [], rules: [], seed: { role: 'a', title: 't' }, messaging: 'board-only', wait: 60 } },
    ],
    ['authoring/triggers/draft', { id: 'nightly', on: 'schedule', opens: { flow: 'sweep' } }],
    [
      'authoring/triggers/render',
      {
        definitions: [{
          id: 'x', on: { kind: 'pull-request', events: ['opened'] }, opens: { flow: 'a' }, goal: ['pr'], again: null,
          dedupe: ['pr'], concurrency: 1, forks: 'never', budget: { usd: 1, rounds: 1, hours: 1, withoutProgress: 1 },
        }],
      },
    ],
  ]
  for (const [method, params] of good) {
    const message = parseClientMessage({ id: 1, method, params }) as unknown as { method: HostMethodName; params: never }
    await dispatch(ctx, message.method, message.params)
  }
  assert.deepEqual(
    calls.map(([name]) => name),
    ['read', 'patch', 'preview', 'apply', 'pending', 'resume', 'discard', 'renderShape', 'triggerDraft', 'renderTriggers'],
  )
  // The seat validator names its optional fields as undefined; what was sent is what arrives.
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1]![1])), [agent, DIGEST, { key: 'prefer', value: [{ runtime: 'fixture' }] }])
  assert.deepEqual(calls[2]![1], [{ target: { kind: 'triggers', origin: 'project', root: ROOT }, expected: null, source: '' }])
})

const setup = async () => {
  const scratch = tempDir('hd-authoring-methods-')
  const project = join(scratch, 'project')
  const home = join(scratch, 'home')
  const builtinAgents = join(scratch, 'builtin-agents')
  const builtinFlows = join(scratch, 'builtin-flows')
  await Promise.all([mkdir(project), mkdir(home), mkdir(join(builtinAgents, 'scout'), { recursive: true }), mkdir(builtinFlows)])
  await writeFile(join(builtinAgents, 'scout', 'AGENT.md'), '---\nname: Scout\nceiling: read\n---\n\nLook around.\n')
  const roster = new Agents({ user: join(home, 'agents'), builtin: builtinAgents })
  const plane = new AuthoringPlane({
    home, journal: join(home, 'authoring'), builtinAgents, builtinFlows,
    confine: async () => {}, agents: (root) => roster.list(root), queue: new TreeQueue(),
  })
  return { project, home, plane }
}

const agentFile = (prefer: string) => `---\nname: Reviewer\nceiling: read\nanswers: [done]\nprefer: [${prefer}]\n---\n\nReview it.\n`

test('creation and scope are explicit', async () => {
  const { project, plane } = await setup()
  const exists = async (path: string) => access(path).then(() => true, () => false)

  // Reading or previewing makes no folder in the repository.
  const triggers = await plane.read({ kind: 'triggers', origin: 'project', root: project })
  assert.equal(triggers.exists, false)
  const created = await plane.preview({ target: { kind: 'agent', origin: 'project', id: 'reviewer', root: project }, expected: null, source: agentFile('fixture') })
  assert.ok(created.token, JSON.stringify(created.issues))
  assert.equal(await exists(join(project, '.harnessdesk')), false)

  // A project's Agent names a runtime; the exact model is this Mac's.
  const model = await plane.preview({ target: { kind: 'agent', origin: 'project', id: 'reviewer', root: project }, expected: null, source: agentFile('"fixture=model-x"') })
  assert.equal(model.token, null)
  assert.ok(model.issues.some((one) => one.fix.startsWith(MODELS_STAY_HERE)), JSON.stringify(model.issues))
  // The same Agent for this person may keep its model.
  const mine = await plane.preview({ target: { kind: 'agent', origin: 'user', id: 'reviewer' }, expected: null, source: agentFile('"fixture=model-x"') })
  assert.ok(mine.token, JSON.stringify(mine.issues))

  // Null expected creates, and never overwrites a file that is there.
  assert.equal((await plane.apply(created.token!)).state, 'applied')
  const again = await plane.preview({ target: { kind: 'agent', origin: 'project', id: 'reviewer', root: project }, expected: null, source: agentFile('fixture') })
  assert.equal(again.token, null)
  assert.ok(again.issues.some((one) => /already there/.test(one.text)))

  // This person's flow may not lean on an Agent only this project has.
  const shape = 'version: 2\nname: Mine\nroles:\n  r: { kind: agent, uses: [reviewer], grant: read }\nseed: { role: r, title: Go }\n'
  const userFlow = await plane.preview({ target: { kind: 'flow', origin: 'user', id: 'mine', root: project }, expected: null, source: shape })
  assert.equal(userFlow.token, null)
  assert.ok(userFlow.issues.some((one) => one.fix.startsWith(COPY_AGENTS_FIRST)), JSON.stringify(userFlow.issues))
  // …while the project's own flow may, and a built-in Agent is everyone's.
  const projectFlow = await plane.preview({ target: { kind: 'flow', origin: 'project', id: 'mine', root: project }, expected: null, source: shape })
  assert.ok(projectFlow.token, JSON.stringify(projectFlow.issues))
  const scoutFlow = await plane.preview({ target: { kind: 'flow', origin: 'user', id: 'mine', root: project }, expected: null, source: shape.replace('[reviewer]', '[scout]') })
  assert.ok(scoutFlow.token, JSON.stringify(scoutFlow.issues))
  // A missing Agent is refused by name, never saved as a flow that points at nothing.
  const missing = await plane.preview({ target: { kind: 'flow', origin: 'project', id: 'mine', root: project }, expected: null, source: shape.replace('[reviewer]', '[nobody]') })
  assert.equal(missing.token, null)
  assert.ok(missing.issues.some((one) => /nobody/.test(one.text)))

  // Built-in files read, and are not writable.
  const scout = await plane.read({ kind: 'agent', origin: 'builtin', id: 'scout' })
  assert.equal(scout.writable, false)
  assert.equal(scout.displayPath, 'scout/AGENT.md')
  const builtinSave = await plane.preview({ target: { kind: 'agent', origin: 'builtin' as never, id: 'scout' }, expected: scout.digest, source: 'x' })
  assert.equal(builtinSave.token, null)
})

test('rendering a shape or a trigger writes nothing and never claims a bad value round-trips', async () => {
  const { plane } = await setup()
  const good: import('@harnessdesk/protocol').FlowPolicy = {
    version: 2, name: 'Mine', inputs: [], messaging: 'board-only', wait: 240,
    roles: [
      { id: 'r', kind: 'agent', uses: ['reviewer'], seats: [], isolate: false, grant: 'read', independentOf: [] },
      { id: 'p', kind: 'person', outcomes: ['done'] },
    ],
    rules: [{ id: 'go', on: 'r', then: { role: 'p', title: 'Decide' } }],
    seed: { role: 'r', title: 'Go' },
  }
  const rendered = await plane.renderShape(good)
  assert.deepEqual(rendered.issues, [])
  assert.match(rendered.source, /name: "Mine"/)
  // A value that cannot survive the round trip is an issue, never a guessed source.
  const bad = await plane.renderShape({ ...good, name: 'bell\u0007' })
  assert.equal(bad.source, '')
  assert.ok(bad.issues.length > 0 && bad.issues.every((one) => one.fix.length > 0))

  // A schedule draft starts disarmed at 60 minutes, from the parser's own defaults.
  const draft = await plane.triggerDraft({ id: 'nightly', on: 'schedule', opens: { flow: 'sweep' } })
  assert.equal(draft.id, 'nightly')
  assert.deepEqual(draft.on, { kind: 'schedule', events: ['tick'], everyMinutes: 60 })
  assert.deepEqual(draft.opens, { flow: 'sweep' })
  assert.deepEqual(draft.goal, ['slot'])
  assert.equal(draft.concurrency, 1)
  await assert.rejects(plane.triggerDraft({ id: 'Not A Slug', on: 'schedule', opens: { flow: 'sweep' } }))

  const rendered2 = await plane.renderTriggers([draft])
  assert.deepEqual(rendered2.issues, [])
  assert.match(rendered2.source, /every: 60/)
  const scheduleAgain = { ...draft, again: { role: 'reviewer', title: 'Continue this work', detail: null } }
  const badTrigger = await plane.renderTriggers([scheduleAgain])
  assert.equal(badTrigger.source, '')
  assert.ok(badTrigger.issues.length > 0)
})
