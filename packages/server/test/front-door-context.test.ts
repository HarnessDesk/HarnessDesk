import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

import { parseClientMessage, ValidationError, type AgentEntry, type SeatPlan } from '@harnessdesk/protocol'

import { factsKey, hostContextPort, previewStart, resolveContext, type FrontDoorPort } from '../src/authoring/start.js'
import { CHANGED_PREVIEW, FlowPreviews } from '../src/flow-preview.js'
import { flowMethods } from '../src/methods/flows.js'
import type { HostContext } from '../src/methods/context.js'
import { tempDir } from './scratch.js'

const run = promisify(execFile)
const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', cwd, '-c', 'user.name=Jane Doe', '-c', 'user.email=dev@example.com', '-c', 'commit.gpgsign=false', ...args])).stdout.trim()

const repository = async (): Promise<string> => {
  const root = tempDir('hd-front-door-repo-')
  await git(root, 'init', '-q', '-b', 'main')
  await writeFile(join(root, 'app.txt'), 'one\n')
  await git(root, 'add', 'app.txt')
  await git(root, 'commit', '-q', '-m', 'one')
  await git(root, 'branch', 'feature')
  return root
}

const reviewer: AgentEntry = {
  id: 'reviewer', origin: 'project', path: '.harnessdesk/agents/reviewer/AGENT.md', digest: 'reviewer-digest', shadows: [], problems: [],
  definition: { id: 'reviewer', name: 'Reviewer', description: null, ceiling: 'read', ceilingFrom: 'ceiling', answers: ['done'], produces: [], skills: [], mcp: [], prefer: [{ runtime: 'holds' }], brief: 'Review.' },
}

const heldPlan = (agent: string): SeatPlan => ({
  id: agent, from: 'prefer', winner: 0, blocked: null, ceiling: { level: 'read', hold: 'held' },
  candidates: [{ seat: { runtime: 'holds' }, label: 'holds', runtimeName: 'Holds', state: 'taken', reason: null, fix: null }],
})

const shape = (binding: 'head' | 'base' | 'branch' | 'pr', contexts: string) => [
  'version: 2',
  'name: Branch review',
  'inputs:',
  '  subject: { label: What to review }',
  'roles:',
  '  reviewer: { kind: agent, uses: [reviewer], grant: read }',
  'seed: { role: reviewer, title: "Review {{subject}}" }',
  `layout: { frontDoor: { contexts: [${contexts}], bindings: [{ input: subject, value: ${binding} }] } }`,
  '',
].join('\n')

type Gh = (args: readonly string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>

const frontDoor = (gh: Gh = async () => ({ stdout: '', exitCode: 1 }), confine: (root: string) => Promise<void> = async () => {}) => {
  const context = hostContextPort(gh)
  const previews = new FlowPreviews({
    confine,
    agents: async () => [reviewer],
    previewAgent: async (_root, agent) => heldPlan(agent),
    resolveTarget: async (start) => factsKey(await resolveContext(context, start)),
    now: () => Date.now(),
  })
  const port: FrontDoorPort = {
    confine,
    context,
    previews,
    goal: async () => { throw new Error('no Goals here') },
    canDispatch: () => ({ ok: true }),
    reserved: () => false,
  }
  const started: unknown[] = []
  const ctx = {
    flowPreviews: previews,
    flows: { startGoal: async (request: unknown) => { started.push(request); return { id: 'run-1' } } },
  } as unknown as HostContext
  return { port, ctx, started }
}

test('moved branch invalidates preview', async () => {
  const root = await repository()
  const first = await git(root, 'rev-parse', 'feature')
  const { port, ctx, started } = frontDoor()
  const source = shape('head', 'branch')
  const preview = await previewStart(port, { context: { kind: 'branch', root, branch: 'feature' }, source, vars: {} })
  assert.ok(preview.flow.token, JSON.stringify(preview.flow.problems))
  assert.deepEqual(preview.vars, { subject: first })
  assert.equal(preview.target.head, first)
  assert.equal(preview.target.independence, 'unknown', 'no author Seat is known for a branch someone else wrote')
  // The branch moves between the dry run and Start.
  await git(root, 'checkout', '-q', 'feature')
  await writeFile(join(root, 'app.txt'), 'two\n')
  await git(root, 'commit', '-q', '-am', 'two')
  await assert.rejects(
    flowMethods['flow/start-goal'](ctx, { root, source, token: preview.flow.token!, sentence: preview.sentence, vars: preview.vars }),
    new RegExp(CHANGED_PREVIEW.replace(/[.]/g, '\\.')),
  )
  assert.deepEqual(started, [], 'nothing started against a head nobody reviewed')
  // A fresh preview binds the new head, and that start carries the held-seat policy the token froze.
  const second = await git(root, 'rev-parse', 'feature')
  const again = await previewStart(port, { context: { kind: 'branch', root, branch: 'feature' }, source, vars: {} })
  assert.deepEqual(again.vars, { subject: second })
  await flowMethods['flow/start-goal'](ctx, { root, source, token: again.flow.token!, sentence: again.sentence, vars: again.vars })
  assert.equal(started.length, 1)
  const request = started[0] as unknown as { requireHeld?: true; vars?: Record<string, string>; authorization: { start?: string } }
  assert.equal(request.requireHeld, true)
  assert.equal(request.authorization.start, 'front-door')
  assert.deepEqual(request.vars, { subject: second })
})

test('working diff never acquires a committed approval', async () => {
  const root = await repository()
  const head = await git(root, 'rev-parse', 'HEAD')
  await writeFile(join(root, 'app.txt'), 'edited, not committed\n')
  await writeFile(join(root, 'new.txt'), 'untracked\n')
  const { port, ctx, started } = frontDoor()
  // A working tree has no committed head to bind: the shape that wants one is refused, never handed HEAD.
  const wantsHead = await previewStart(port, { context: { kind: 'working-diff', root }, source: shape('head', 'working-diff'), vars: {} })
  assert.equal(wantsHead.flow.token, null)
  assert.ok(wantsHead.flow.problems.some((one) => /fills “subject” from the head, which the working tree \(not committed\) does not have/.test(one.text)))
  assert.equal(wantsHead.target.head, null)
  assert.equal(wantsHead.target.dirty, true)
  assert.equal(wantsHead.target.base, head)
  assert.match(wantsHead.target.label, /not committed/)
  // What it has is the commit it sits on, named as the base.
  const source = shape('base', 'working-diff')
  const onBase = await previewStart(port, { context: { kind: 'working-diff', root }, source, vars: {} })
  assert.ok(onBase.flow.token, JSON.stringify(onBase.flow.problems))
  assert.deepEqual(onBase.vars, { subject: head })
  assert.equal(onBase.target.head, null)
  // The snapshot is bound: an untracked file edited after the dry run changes what would be reviewed.
  await writeFile(join(root, 'new.txt'), 'untracked, and edited again\n')
  await assert.rejects(flowMethods['flow/start-goal'](ctx, { root, source, token: onBase.flow.token!, sentence: onBase.sentence, vars: onBase.vars }), /Review the dry run again/)
  assert.deepEqual(started, [])
})

test('host resolves PR without following input URL', async () => {
  const root = await repository()
  const params = (context: unknown, extra: Record<string, unknown> = {}) => ({ id: 1, method: 'authoring/start/preview', params: { context, source: 'x', vars: {}, ...extra } })
  // Refused on the wire, before any handler: a URL, a non-number, an option-like ref, a range, a relative or foreign-shaped root.
  for (const context of [
    { kind: 'pull-request', root, number: 'https://github.com/acme/widgets/pull/7' },
    { kind: 'pull-request', root, number: '7' },
    { kind: 'pull-request', root, number: 0 },
    { kind: 'pull-request', root, number: -7 },
    { kind: 'pull-request', root, number: 7.5 },
    { kind: 'pull-request', root, number: 7, url: 'https://github.com/acme/widgets/pull/7' },
    { kind: 'branch', root, branch: '--upload-pack=touch x' },
    { kind: 'branch', root, branch: '-x' },
    { kind: 'branch', root, branch: 'main..feature' },
    { kind: 'diff', root, from: 'HEAD^@', to: 'HEAD' },
    { kind: 'pull-request', root: 'relative/repo', number: 7 },
    { kind: 'project', root, grant: 'merge' },
  ]) {
    assert.throws(() => parseClientMessage(params(context)), ValidationError, JSON.stringify(context))
  }
  assert.throws(() => parseClientMessage(params({ kind: 'project', root }, { requireHeld: false })), ValidationError)
  assert.doesNotThrow(() => parseClientMessage(params({ kind: 'pull-request', root, number: 7 })))

  // A positive number in an admitted project: the forge is asked about that number, in that project, and nothing else.
  const head = await git(root, 'rev-parse', 'HEAD')
  const calls: [readonly string[], string][] = []
  const gh: Gh = async (args, cwd) => {
    calls.push([args, cwd])
    return { stdout: JSON.stringify({ number: 7, headRefOid: head, baseRefOid: head, headRefName: 'feature' }), exitCode: 0 }
  }
  const { port } = frontDoor(gh, async (candidate) => { if (candidate !== root) throw new Error(`${candidate} is outside every open workspace.`) })
  const preview = await previewStart(port, { context: { kind: 'pull-request', root, number: 7 }, source: shape('pr', 'pull-request'), vars: {} })
  assert.ok(preview.flow.token, JSON.stringify(preview.flow.problems))
  assert.deepEqual(preview.vars, { subject: '7' })
  assert.equal(preview.target.label, 'pull request #7')
  assert.deepEqual(calls, [[['pr', 'view', '7', '--json', 'number,headRefOid,baseRefOid,headRefName'], root]])
  // A forge that answers for another pull request is not believed.
  const liar = frontDoor(async () => ({ stdout: JSON.stringify({ number: 8, headRefOid: head, baseRefOid: head }), exitCode: 0 }))
  await assert.rejects(previewStart(liar.port, { context: { kind: 'pull-request', root, number: 7 }, source: shape('pr', 'pull-request'), vars: {} }), /There is no pull request #7/)
  // A folder that is not open here is refused before the forge or git is asked anything.
  calls.length = 0
  const foreign = tempDir('hd-front-door-foreign-')
  await assert.rejects(previewStart(port, { context: { kind: 'pull-request', root: foreign, number: 7 }, source: shape('pr', 'pull-request'), vars: {} }), /outside every open workspace/)
  assert.deepEqual(calls, [])
})
