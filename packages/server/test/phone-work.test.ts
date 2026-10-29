import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  approvalId, itemId, runtimeId, sessionId, turnId, type Approval, type ApprovalOption, type PhoneWorkSnapshot, type Session, type SessionSummary, type Turn,
} from '@harnessdesk/protocol'
import { PhoneWork, phoneSessionValues, WorkspaceFeed, type PhoneWorkPorts } from '../src/phone-work.js'
import { boundLeadChatRead } from '../src/lead/chat-read.js'
import { assessApproval, isLowRiskCommand } from '../src/phone-thread.js'

const RT = runtimeId('agent-a')
const SID = sessionId('s1')
const CWD = '/home/dev/acme-api'
const HOME = '/home/dev'

const allow: ApprovalOption = { id: 'allow', label: 'Yes', intent: 'approve' }
const deny: ApprovalOption = { id: 'deny', label: 'No', intent: 'deny' }
const forTool: ApprovalOption = { id: 'always-tool', label: 'Yes, and stop asking this session', intent: 'approveAlways', grant: 'session-tool' }
const forServer: ApprovalOption = { id: 'always-server', label: 'Yes, for this whole server', intent: 'approveAlways', grant: 'session-server' }
const forever: ApprovalOption = { id: 'always-forever', label: 'Yes, always', intent: 'approveAlways', grant: 'permanent' }
const loose: ApprovalOption = { id: 'always-loose', label: 'Always', intent: 'approveAlways' }

const command = (command: string, over: Partial<Extract<Approval, { type: 'command' }>> = {}): Approval => ({
  id: approvalId('ap-1'), sessionId: SID, requestedAt: 1, type: 'command', command, cwd: CWD, actions: [], options: [allow, forTool, deny], ...over,
})

const session = (turns: Turn[], over: Partial<Session> = {}): Session => ({
  id: SID, runtime: RT, title: 'Fix the importer', cwd: CWD, status: { type: 'idle' }, createdAt: 1, updatedAt: 2, turns, itemsLoaded: true, ...over,
})

interface Rig { work: PhoneWork; responded: any[]; setPending(next: Approval[]): void; setSession(next: Session): void; setRunning(next: boolean): void }

const rig = (over: Partial<PhoneWorkPorts> = {}): Rig => {
  const responded: any[] = []
  let pending: Approval[] = []
  let current = session([])
  let running = false
  const ports: PhoneWorkPorts = {
    workspace: { workItems: async () => [], workUsage: async () => undefined, workSessions: () => ({ items: [], nextCursor: null }) },
    deskName: () => 'Studio Mac',
    home: HOME,
    seatName: runtime => runtime === RT ? 'Agent A' : null,
    isOwn: (runtime, id) => runtime === RT && id === SID,
    summary: () => null,
    read: async () => current,
    live: () => ({ running, pending, cwd: CWD }),
    defaultRuntime: () => RT, projectRoots: () => [], canInterrupt: () => true,
    newSessionValues: async () => ({}), create: async () => session([]), send: async () => {}, queue: async () => ({ queuedId: null, sent: true }), interrupt: async () => {},
    respond: async params => { responded.push(params); pending = pending.filter(one => one.id !== params.approvalId) },
    hasSecret: text => /sk-[A-Za-z0-9]{10,}/.test(text),
    now: () => 1_000,
    ...over,
  }
  return { work: new PhoneWork(ports), responded, setPending: next => { pending = next }, setSession: next => { current = next }, setRunning: next => { running = next } }
}

const key = `${RT}:${SID}`

test('which commands a phone may call low risk is decided by what they touch, and anything unknown is high', () => {
  const low = ['ls -la', 'git status', 'git diff --stat', 'git log -5 --oneline', 'rg TODO src', 'cat package.json', 'pnpm test', 'pnpm run lint',
    'npm test --silent', 'cargo test', 'find . -name "*.ts"', 'tsc --noEmit', 'pytest -q', `cat ${CWD}/README.md`]
  const high = ['rm -rf build', 'ls > out.txt', 'cat a && curl x', 'git push', 'git -C /tmp status', 'git diff --output=x', 'find . -delete', 'rg --pre cmd x',
    'curl https://example.com', 'FOO=1 ls', '/bin/ls', 'echo $(whoami)', 'ls `pwd`', 'sleep 1 & ls', 'pnpm --filter x test', 'npm run deploy',
    'pnpm install', 'git branch -D x', 'node script.js', '', 'ls | sh', 'cat .env', 'cat .env.local', 'ls ..', 'cat /etc/passwd', 'ls ~', 'cat ../x', 'ls .ssh', 'git show HEAD:.github/workflows/ci.yml']
  for (const one of low) assert.equal(isLowRiskCommand(one, CWD), true, one)
  for (const one of high) assert.equal(isLowRiskCommand(one, CWD), false, one)
  assert.equal(isLowRiskCommand('ls', null), true)
  assert.equal(isLowRiskCommand('cat /home/dev/acme-api/a', null), false, 'with no project, nothing absolute is inside it')
})

test('an approval is drawn without the machine, and only a low risk one offers the session grant', () => {
  const ctx = { home: HOME, seat: 'Agent A', hasSecret: (text: string) => /sk-[A-Za-z0-9]{10,}/.test(text) }
  const plain = assessApproval(command(`cat ${CWD}/src/a.ts ${HOME}/notes.txt`, { reason: `needs ${HOME}/notes.txt` }), CWD, ctx)!
  assert.equal(plain.turn.command, 'cat ./src/a.ts ~/notes.txt')
  assert.equal(plain.turn.why, 'needs …')
  assert.equal(plain.turn.highRisk, true, 'a read of the home folder is outside the project')
  assert.equal(plain.turn.sessionGrant, undefined)

  const test_ = assessApproval(command('pnpm test'), CWD, ctx)!
  assert.equal(test_.turn.highRisk, false)
  assert.equal(test_.turn.sessionGrant, 'Yes, and stop asking this session')
  assert.deepEqual(test_.options, { once: allow, session: forTool, deny })
  assert.equal(test_.turn.who, 'Agent A')
  assert.equal(test_.turn.state, 'pending')

  // The tool-scoped option wins over a server-wide one, and nothing without a session scope is ever picked.
  const both = assessApproval(command('pnpm test', { options: [allow, forServer, forTool, forever, loose, deny] }), CWD, ctx)!
  assert.equal(both.options.session, forTool)
  const wide = assessApproval(command('pnpm test', { options: [allow, forever, loose, deny] }), CWD, ctx)!
  assert.equal(wide.options.session, undefined)
  assert.equal(wide.turn.sessionGrant, undefined, 'a permanent or unscoped option is not "until the session ends"')
  assert.equal(assessApproval(command('pnpm test', { options: [allow, forServer, deny] }), CWD, ctx)!.options.session, forServer)

  // High risk: no grant even where the desk has the option.
  const danger = assessApproval(command('rm -rf build'), CWD, ctx)!
  assert.equal(danger.turn.highRisk, true)
  assert.equal(danger.turn.sessionGrant, undefined)
  assert.equal(danger.options.session, forTool, 'the option exists on the desk; the phone is just never told of it')
})

test('what could hold a secret, a cut command and typed input are shown as hidden and cannot be allowed from a phone', () => {
  const ctx = { home: HOME, seat: 'Agent A', hasSecret: (text: string) => /sk-[A-Za-z0-9]{10,}/.test(text) }
  const secret = assessApproval(command('curl -H "Authorization: Bearer sk-abcdefghijklmnop" https://example.com'), CWD, ctx)!
  assert.equal(secret.readable, false)
  assert.equal(secret.turn.highRisk, true)
  assert.ok(!JSON.stringify(secret.turn).includes('sk-abcdef'))
  const long = assessApproval(command(`echo ${'x '.repeat(500)}`), CWD, ctx)!
  assert.equal(long.readable, false)
  const stdin = assessApproval(command('sudo tool', { kind: 'stdin', input: 'hunter2' }), CWD, ctx)!
  assert.equal(stdin.readable, false)
  assert.equal(stdin.turn.highRisk, true)
  assert.ok(!JSON.stringify(stdin.turn).includes('hunter2'))
})

test('a change is high risk when it deletes, leaves the project, touches code that runs later, or widens the sandbox', () => {
  const ctx = { home: HOME, seat: 'Agent A' }
  const change = (path: string, kind: { type: 'add' } | { type: 'delete' } | { type: 'update'; movePath?: string | null }, over: object = {}): Approval => ({
    id: approvalId('ap-2'), sessionId: SID, requestedAt: 1, type: 'fileChange', changes: [{ path, kind, diff: '@@\n-a\n+b' }], options: [allow, forTool, deny], ...over,
  } as Approval)
  const fine = assessApproval(change(`${CWD}/src/a.ts`, { type: 'update' }), CWD, ctx)!
  assert.equal(fine.turn.highRisk, false)
  assert.equal(fine.turn.command, 'edit src/a.ts')
  assert.equal(fine.turn.title, 'Change 1 file')
  for (const risky of [
    change(`${CWD}/src/a.ts`, { type: 'delete' }), change('/etc/hosts', { type: 'update' }), change('../x.ts', { type: 'add' }), change('.github/workflows/ci.yml', { type: 'update' }),
    change('.env', { type: 'add' }), change('a.ts', { type: 'update', movePath: '../b.ts' }), change('a.ts', { type: 'update' }, { grantRoot: '/home/dev' }), change('a.ts', { type: 'update' }, { changes: [] }),
  ]) assert.equal(assessApproval(risky, CWD, ctx)!.turn.highRisk, true, JSON.stringify((risky as { changes: unknown }).changes))
  assert.ok(!JSON.stringify(fine.turn).includes('@@'), 'no line of a change leaves')

  const permission = assessApproval({ id: approvalId('ap-3'), sessionId: SID, requestedAt: 1, type: 'permission', summary: `Write to ${CWD}/x`, options: [allow, deny] }, CWD, ctx)!
  assert.equal(permission.turn.highRisk, true)
  assert.equal(permission.turn.command, 'Write to …')
  assert.equal(assessApproval({ id: approvalId('ap-4'), sessionId: SID, requestedAt: 1, type: 'userInput', tool: 'Ask', questions: [] }, CWD, ctx), null)
})

test('the snapshot says what the desk honours, in micro-dollars, with usage left out until there is some', async () => {
  const empty = await rig().work.snapshot()
  assert.deepEqual(empty, {
    deskName: 'Studio Mac', items: [], models: [], flows: [], commands: [], threads: [],
    capabilities: { startSession: true, startTeam: false, reply: true, stop: true, delete: false, chooseModel: false, choosePermissions: false, attach: false, undo: false, decide: true },
  })
  assert.ok(!('usage' in empty))
  const usage = { spentToday: { micros: 1_250_000 } } as never
  const withUsage = await rig({ workspace: { workItems: async () => [], workUsage: async () => usage, workSessions: () => ({ items: [], nextCursor: null }) } }).work.snapshot()
  assert.deepEqual(withUsage.usage, usage)
  const named = await rig({ deskName: () => `Jane at dev@example.com ${HOME}/x` }).work.snapshot()
  assert.ok(!/@|\/home/.test(named.deskName), named.deskName)
})

test('a conversation is read as what was asked, answered and done, with no output, no change lines and no path', async () => {
  // The sessions list's own summary names the project, and the conversation says the same.
  const r = rig({ summary: () => ({ repo: { root: CWD } }) as unknown as SessionSummary })
  r.setSession(session([{
    id: turnId('t1'), status: 'completed', startedAt: 1_000, completedAt: 75_000,
    items: [
      { id: itemId('i1'), type: 'userMessage', content: [{ type: 'text', text: `Fix ${CWD}/src/auth.ts for dev@example.com` }, { type: 'image', url: 'data:image/png;base64,AAAA', name: 'shot.png' }] },
      { id: itemId('i2'), type: 'assistantMessage', phase: 'commentary', text: 'Looking at the sign-in code first.', startedAt: 2_000, completedAt: 2_000 },
      { id: itemId('i3'), type: 'command', command: `rg -n token ${CWD}/src --password hunter2`, cwd: CWD, origin: 'agent', status: 'completed', actions: [], output: `${CWD}/src/auth.ts:1: SECRET=abc`, exitCode: 0, startedAt: 3_000, completedAt: 5_000, durationMs: 2_000 },
      { id: itemId('i4'), type: 'command', command: 'pnpm test', cwd: CWD, origin: 'agent', status: 'failed', actions: [], output: '1 failing', exitCode: 1 },
      { id: itemId('i5'), type: 'fileChange', status: 'completed', changes: [{ path: `${CWD}/src/auth.ts`, kind: { type: 'update' }, diff: '--- a\n+++ b\n@@\n-old secret\n+new secret\n+more' }, { path: '/etc/outside.conf', kind: { type: 'add' }, diff: 'one\ntwo' }] },
      { id: itemId('i6'), type: 'toolCall', tool: 'mcp__server__do_thing', source: { kind: 'mcp', server: 'tracker' }, status: 'completed', args: { token: 'sk-abcdefghijklmnop' }, startedAt: 70_000, completedAt: 76_000 },
      { id: itemId('i7'), type: 'assistantMessage', phase: 'final', text: `Done. I edited ${CWD}/src/auth.ts. Ask dev@example.com if it breaks.` },
      { id: itemId('i8'), type: 'notice', text: 'a slash command echo' },
    ],
    plan: [{ step: 'Find the bug', status: 'completed' }, { step: 'Fix it', status: 'inProgress' }],
  }]))
  const thread = await r.work.threadRead({ id: key })
  assert.equal(thread.id, key)
  assert.equal(thread.title, 'Fix the importer')
  assert.equal(thread.project, 'acme-api')
  assert.deepEqual(thread.agent, { name: 'Agent A' })
  assert.equal(thread.status, 'done')
  assert.deepEqual(thread.turns.map(turn => turn.type), ['you', 'work', 'agent', 'changes'])

  const [you, work, agent, changes] = thread.turns as [any, any, any, any]
  assert.equal(you.text, 'Fix … for …')
  assert.deepEqual(you.attachments, ['shot.png'])
  assert.equal(agent.markdown, 'Done. I edited …. Ask … if it breaks.')
  assert.deepEqual(work.steps.map((one: any) => [one.kind, one.title]), [
    ['thought', 'Looking at the sign-in code first.'], ['run', 'rg'], ['run', 'pnpm test'], ['edit', 'Edited 2 files'], ['run', 'Used tracker'], ['todo', 'Plan'],
  ])
  assert.equal(work.summary, 'Ran 3 commands, edited 2 files')
  assert.equal(work.seconds, 74)
  assert.deepEqual(work.steps[2].exitCode, 1)
  assert.equal(work.steps[2].failed, true)
  assert.deepEqual(work.steps[3].files, ['src/auth.ts', 'outside.conf'])
  assert.deepEqual(work.steps[5].todos, [{ text: 'Find the bug', done: true, active: false }, { text: 'Fix it', done: false, active: true }])
  assert.ok(work.steps.every((one: any) => one.output.length === 0))
  assert.deepEqual(changes.files, [{ path: 'src/auth.ts', added: 2, removed: 1, hunks: [] }, { path: 'outside.conf', added: 2, removed: 0, hunks: [] }])

  const text = JSON.stringify(thread)
  for (const leak of ['/home', '@', 'hunter2', 'SECRET', 'sk-abcdef', 'old secret', 'new secret', 'failing', 'etc/outside']) assert.ok(!text.includes(leak), `${leak} leaked: ${text}`)
})

test('a conversation waiting on an approval shows it, and a structured question is said in a sentence', async () => {
  const r = rig()
  r.setPending([command('pnpm test'), { id: approvalId('ap-q'), sessionId: SID, requestedAt: 2, type: 'userInput', tool: 'AskUser', questions: [{ id: 'q', question: 'Which database?', multiSelect: false, options: [] }] }])
  const thread = await r.work.threadRead({ id: key })
  assert.equal(thread.status, 'asksYou')
  assert.deepEqual(thread.turns.map(turn => turn.type), ['agent', 'approval'])
  assert.equal((thread.turns[0] as any).markdown, 'The agent asked a question. Answer it on the desk.')
  assert.ok(!JSON.stringify(thread).includes('database'))
  r.setPending([])
  r.setRunning(true)
  assert.equal((await r.work.threadRead({ id: key })).status, 'running')
})

test('a thread read refuses what is not one of the person’s own conversations, without saying more', async () => {
  const r = rig({ read: async () => { throw new Error(`ENOENT: open '${CWD}/secret/history.jsonl' for dev@example.com`) } })
  for (const id of ['', 'nocolon', ':s1', 'agent-a:', 'other:s1', `${RT}:other`, 'goal-1']) {
    await assert.rejects(r.work.threadRead({ id }), /not a session this desk can show/, id)
  }
  await assert.rejects(r.work.threadRead({ id: key }), (error: Error) => !/home|@/.test(error.message) && /ENOENT/.test(error.message))
})

test('allowing once picks the approval’s plain allow, and the thread then shows it as allowed', async () => {
  const r = rig()
  r.setPending([command('pnpm test')])
  assert.deepEqual(await r.work.approvalDecide({ id: 'ap-1', session: key, allow: true, scope: 'once' }), {})
  assert.deepEqual(r.responded, [{ runtime: RT, sessionId: SID, approvalId: 'ap-1', decision: { type: 'option', optionId: 'allow' } }])
  const thread = await r.work.threadRead({ id: key })
  assert.deepEqual(thread.turns.map(turn => turn.type === 'approval' ? [turn.id, turn.state] : turn.type), [['ap-1', 'allowed']])
  assert.equal(thread.status, 'done')
  await assert.rejects(r.work.approvalDecide({ id: 'ap-1', session: key, allow: true }), /not waiting any more/)
})

test('allowing for the session picks the session-scoped option and nothing wider', async () => {
  const r = rig()
  r.setPending([command('pnpm test', { options: [allow, forever, forServer, loose, forTool, deny] })])
  await r.work.approvalDecide({ id: 'ap-1', session: key, allow: true, scope: 'session' })
  assert.equal(r.responded[0]?.decision.optionId, 'always-tool')
  const turn = (await r.work.threadRead({ id: key })).turns[0] as any
  assert.equal(turn.state, 'allowedForSession')
  assert.equal(turn.sessionGrant, 'Yes, and stop asking this session')

  const server = rig()
  server.setPending([command('pnpm test', { options: [allow, forever, loose, forServer, deny] })])
  await server.work.approvalDecide({ id: 'ap-1', session: key, allow: true, scope: 'session' })
  assert.equal(server.responded[0]?.decision.optionId, 'always-server')
})

test('the session grant is refused for a high risk request, for a deny, and where the desk has no session option', async () => {
  const cases: [string, Approval, { allow: boolean; scope: 'session' | 'once' }, RegExp][] = [
    ['high risk', command('rm -rf build'), { allow: true, scope: 'session' }, /cannot be allowed for the whole session/],
    ['deny', command('pnpm test'), { allow: false, scope: 'session' }, /Only an allow can last/],
    ['no session option', command('pnpm test', { options: [allow, forever, loose, deny] }), { allow: true, scope: 'session' }, /cannot be allowed for the whole session/],
    ['permanent only', command('pnpm test', { options: [forever, deny] }), { allow: true, scope: 'once' }, /cannot be allowed once/],
  ]
  for (const [name, approval, how, message] of cases) {
    const r = rig()
    r.setPending([approval])
    await assert.rejects(r.work.approvalDecide({ id: 'ap-1', session: key, ...how }), message, name)
    assert.deepEqual(r.responded, [], `${name}: nothing reached the agent`)
  }
})

test('a high risk request can be allowed once and an unreadable one cannot be allowed at all, but either can be declined', async () => {
  const risky = rig()
  risky.setPending([command('rm -rf build')])
  await risky.work.approvalDecide({ id: 'ap-1', session: key, allow: true, scope: 'once' })
  assert.equal(risky.responded[0]?.decision.optionId, 'allow')
  assert.equal(((await risky.work.threadRead({ id: key })).turns[0] as any)?.highRisk, true)

  const hidden = rig()
  hidden.setPending([command('curl -H "Authorization: Bearer sk-abcdefghijklmnop" https://example.com')])
  await assert.rejects(hidden.work.approvalDecide({ id: 'ap-1', session: key, allow: true }), /too long or too sensitive/)
  assert.deepEqual(hidden.responded, [])
  await hidden.work.approvalDecide({ id: 'ap-1', session: key, allow: false })
  assert.equal((hidden.responded as any[])[0]?.decision.optionId, 'deny')
  assert.equal(((await hidden.work.threadRead({ id: key })).turns[0] as any)?.state, 'denied')

  const cancelOnly = rig()
  cancelOnly.setPending([command('pnpm test', { options: [allow, { id: 'stop', label: 'Stop', intent: 'cancel' }] })])
  await cancelOnly.work.approvalDecide({ id: 'ap-1', session: key, allow: false })
  assert.equal(cancelOnly.responded[0]?.decision.optionId, 'stop')

  const none = rig()
  none.setPending([command('pnpm test', { options: [allow] })])
  await assert.rejects(none.work.approvalDecide({ id: 'ap-1', session: key, allow: false }), /cannot be declined/)
})

test('a structured question and a stranger’s session are not answered', async () => {
  const r = rig()
  r.setPending([{ id: approvalId('ap-q'), sessionId: SID, requestedAt: 2, type: 'userInput', tool: 'AskUser', questions: [] }])
  await assert.rejects(r.work.approvalDecide({ id: 'ap-q', session: key, allow: true }), /Answer it on the desk/)
  await assert.rejects(r.work.approvalDecide({ id: 'ap-q', session: `${RT}:other`, allow: false }), /not a session this desk can show/)
  await assert.rejects(r.work.approvalDecide({ id: 'nope', session: key, allow: false }), /not waiting any more/)
  assert.deepEqual(r.responded, [])
})

test('a failure answering the agent reaches the phone without a path or an address', async () => {
  const r = rig({ respond: async () => { throw new Error(`No approval is pending with id ap-1 in ${CWD}/x for dev@example.com`) } })
  r.setPending([command('pnpm test')])
  await assert.rejects(r.work.approvalDecide({ id: 'ap-1', session: key, allow: true }), (error: Error) => /No approval is pending/.test(error.message) && !/home|@/.test(error.message))
})

test('what the phone answered is remembered for a day, and a thread shows the last twenty', async () => {
  let now = 1_000
  const r = rig({ now: () => now })
  for (let i = 0; i < 3; i++) {
    r.setPending([command('pnpm test', { id: approvalId(`ap-${i}`) })])
    await r.work.approvalDecide({ id: `ap-${i}`, session: key, allow: i !== 1 })
  }
  assert.deepEqual((await r.work.threadRead({ id: key })).turns.map(turn => turn.type === 'approval' ? turn.state : null), ['allowed', 'denied', 'allowed'])
  for (let i = 3; i < 30; i++) {
    r.setPending([command('pnpm test', { id: approvalId(`ap-${i}`) })])
    await r.work.approvalDecide({ id: `ap-${i}`, session: key, allow: true })
  }
  const shown = (await r.work.threadRead({ id: key })).turns.map(turn => turn.id)
  assert.equal(shown.length, 20)
  assert.equal(shown.at(-1), 'ap-29')
  now += 25 * 60 * 60 * 1000
  assert.deepEqual((await r.work.threadRead({ id: key })).turns, [])
})

test('the change feed publishes a snapshot only when it differs, only while a phone listens, and one at a time', async () => {
  let listening = false
  let version = 1
  let builds = 0
  let hold: Promise<void> | null = null
  let release = () => {}
  const published: PhoneWorkSnapshot[] = []
  const feed = new WorkspaceFeed({
    delayMs: 5,
    listening: () => listening,
    build: async () => {
      builds++
      if (hold) await hold
      return { deskName: `v${version}`, items: [], models: [], flows: [], commands: [], capabilities: {} as never, threads: [] }
    },
    publish: snapshot => { published.push(snapshot) },
  })
  const settle = () => new Promise(resolve => setTimeout(resolve, 40))

  feed.poke(); await settle()
  assert.equal(builds, 0, 'with nobody listening nothing is built')

  listening = true
  feed.poke(); feed.poke(); feed.poke(); await settle()
  assert.deepEqual(published.map(one => one.deskName), ['v1'])
  assert.equal(builds, 1, 'pokes in one moment are one build')

  feed.poke(); await settle()
  assert.equal(builds, 2)
  assert.equal(published.length, 1, 'an identical snapshot is not published again')

  version = 2
  hold = new Promise<void>(resolve => { release = resolve })
  feed.poke(); await new Promise(resolve => setTimeout(resolve, 20))
  feed.poke() // arrives while the build is in flight
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(builds, 3, 'a second build does not start while one is running')
  hold = null
  release(); await settle()
  assert.deepEqual(published.map(one => one.deskName), ['v1', 'v2'])
  assert.equal(builds, 4, 'the poke that arrived meanwhile ran once the first finished')

  feed.dispose()
  version = 3
  feed.poke(); await settle()
  assert.equal(published.length, 2)
})


test('a failed first send returns the created session instead of losing its identity', async () => {
  const { work } = rig({ send: async () => { throw new Error('Synthetic first-send refusal') } })
  const result = await work.sessionStart({ text: 'Keep this draft' })
  assert.equal(result.id, `${RT}:${SID}`)
  assert.match((result as { problem?: string }).problem ?? '', /created.*first message|first message.*confirm/i)
})

test('an invalidated workspace feed retries a failed build and republishes an identical snapshot', async t => {
  let fail = false, builds = 0
  const published: PhoneWorkSnapshot[] = []
  const snapshot = { deskName: 'Same', items: [], models: [], flows: [], commands: [], capabilities: {} as never, threads: [] }
  const feed = new WorkspaceFeed({ delayMs: 5, listening: () => true, build: async () => {
    builds++
    if (fail) { fail = false; throw new Error('Transient snapshot read failure') }
    return snapshot
  }, publish: value => { published.push(value) } })
  t.after(() => feed.dispose())
  feed.poke()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(published.length, 1)
  fail = true
  feed.poke(true)
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(published.length, 2)
  assert.ok(builds >= 3)
})


test('phone starts resolve model selectors before dependent recommendations', async () => {
  const calls: any[] = []
  const values = await phoneSessionValues(RT, undefined, {}, async params => {
    const model = params.values?.['model'] ?? 'one'
    const effort = params.values?.['effort'] ?? (model === 'two' ? 'low' : 'high')
    calls.push(params.values ?? {})
    if (model === 'two' && effort === 'high') throw new Error('The recommended model cannot use old high effort')
    return [
      { id: 'model', type: 'select', category: 'model', label: 'Model', currentValue: model as string,
        choices: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }], recommendedValue: 'two' },
      { id: 'effort', type: 'select', category: 'thought_level', label: 'Effort', currentValue: effort as string,
        choices: [{ value: model === 'two' ? 'low' : 'high', label: 'Effort' }], recommendedValue: model === 'two' ? 'low' : 'high' },
    ]
  })
  assert.deepEqual(values, { model: 'two', effort: 'low' })
  assert.ok(calls.some(value => value.model === 'two' && value.effort === undefined))
})


test('a saved profile keeps its implicit model while its dependent choices are validated', async () => {
  const values = await phoneSessionValues(RT, undefined, { draftValues: { [RT]: { profile: 'two', effort: 'low' } } }, async params => {
    const profile = params.values?.['profile'] ?? ''
    const model = profile === 'two' ? 'two' : 'one'
    if (profile === 'two' && 'model' in (params.values ?? {})) throw new Error('Profile owns its model')
    return [
      { id: 'profile', type: 'select', category: '_profile', label: 'Profile', currentValue: profile as string,
        choices: [{ value: '', label: 'None' }, { value: 'two', label: 'Two' }] },
      { id: 'model', type: 'select', category: 'model', label: 'Model', currentValue: model,
        choices: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }], recommendedValue: 'one' },
      { id: 'effort', type: 'select', category: 'thought_level', label: 'Effort', currentValue: (params.values?.['effort'] ?? (model === 'two' ? 'low' : 'high')) as string,
        choices: [{ value: model === 'two' ? 'low' : 'high', label: 'Effort' }], recommendedValue: model === 'two' ? 'low' : 'high' },
    ]
  })
  assert.deepEqual(values, { profile: 'two', effort: 'low' })
})

test('saved dependent choices incompatible with the selected model refuse before a combined resolver call', async () => {
  const calls: any[] = []
  await assert.rejects(phoneSessionValues(RT, undefined, { draftValues: { [RT]: { model: 'two', effort: 'high' } } }, async params => {
    calls.push(params.values ?? {})
    const model = params.values?.['model'] ?? 'one'
    return [
      { id: 'model', type: 'select', category: 'model', label: 'Model', currentValue: model as string,
        choices: [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }] },
      { id: 'effort', type: 'select', category: 'thought_level', label: 'Effort', currentValue: model === 'two' ? 'low' : 'high',
        choices: [{ value: model === 'two' ? 'low' : 'high', label: 'Effort' }] },
    ]
  }), /saved.*choices/i)
  assert.deepEqual(calls, [{}, { model: 'two' }])
})

test('a host-pinned start uses the exact root and saved defaults with fresh admission before allocation and send', async () => {
  const seen: unknown[] = []
  const { work } = rig({
    newSessionValues: async (runtime, cwd) => { seen.push({ runtime, cwd }); return { permissions: 'workspace' } },
    create: async params => { seen.push(params); return session([]) },
    send: async params => { seen.push(params) },
  })
  const start = (work as unknown as { startInProject?: (params: { text: string }, root: string, admit: () => Promise<void>) => Promise<unknown> }).startInProject
  assert.equal(typeof start, 'function', 'A trusted exact-root start must share the phone ordinary session lifecycle')
  await start!.call(work, { text: 'Work here' }, CWD, async () => { seen.push('admit') })
  assert.deepEqual(seen, [
    { runtime: RT, cwd: CWD }, 'admit', { runtime: RT, options: { cwd: CWD, options: { permissions: 'workspace' } } },
    'admit', { runtime: RT, sessionId: SID, input: [{ type: 'text', text: 'Work here' }] },
  ])
})

test('pinned starts preserve allocated identity when admission changes before the first send', async () => {
  let sends = 0, creates = 0
  const { work } = rig({ create: async () => { creates++; return session([]) }, send: async () => { sends++ } })
  const result = await work.startInProject({ text: 'Work here' }, CWD, async id => { if (id) throw new Error('Project was withdrawn') })
  assert.equal(result.id, key)
  assert.match(result.problem ?? '', /created.*first message/i)
  assert.equal(creates, 1); assert.equal(sends, 0)
})

test('admission changing during new-session defaults refuses before allocating a conversation', async () => {
  let creates = 0
  const { work } = rig({ create: async () => { creates++; return session([]) } })
  await assert.rejects(work.startInProject({ text: 'Work here' }, CWD, async () => { throw new Error('Budget exhausted') }), /Budget exhausted/)
  assert.equal(creates, 0)
})

for (const scenario of ['history', 'message', 'combined'] as const) test(`Lead discloses ${scenario} truncation through the shared PhoneWork projection`, async () => {
  const r = rig()
  const count = scenario === 'message' ? 1 : 45
  const text = scenario === 'history' ? 'Short reply' : 'Useful context. '.repeat(425)
  assert.equal(scenario === 'history' || text.length === 6800, true)
  r.setSession(session(Array.from({ length: count }, (_, i) => ({ id: turnId(`t${i}`), status: 'completed' as const,
    items: [{ id: itemId(`m${i}`), type: 'assistantMessage' as const, text }] }))))
  const projected = await r.work.threadRead({ id: key })
  const result = boundLeadChatRead(projected)
  assert.equal(result.truncated, true)
  assert.equal(result.omittedTurns + result.turns.length, count)
  assert.equal('omittedTurns' in JSON.parse(JSON.stringify(projected)), false, 'phone wire shape stays unchanged')
  if (scenario === 'history') assert.equal(result.omittedTurns, 5)
  assert.equal(result.turns.at(-1)?.id, `m${count - 1}`)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 12000)
})
