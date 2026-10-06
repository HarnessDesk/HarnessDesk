import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import { CodexRuntime } from '@harnessdesk/adapter-codex'
import { sessionId, type AgentEvent, type CommandApproval, type RuntimeId, type Session, type SessionQueue, type UserContent } from '@harnessdesk/protocol'

import { QUEUE_LIMIT } from '../src/registry.js'
import { Client, start, stop, type Harness } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * The queue contract exercised through the host socket and each production
 * adapter, with each adapter's own scripted child process. This table is the
 * runtime-shape boundary: a new adapter adds one row here.
 */
const CODEX_FAKE = fileURLToPath(new URL('../../../adapter-codex/dist/test/fixtures/fake-codex.mjs', import.meta.url))
const ACP_FAKE = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))

interface RuntimeShape {
  readonly name: string
  readonly id: RuntimeId
  readonly initialPrompt: string
  readonly approvalGated: boolean
  readonly firstSeatModel: string
  readonly fallbackSeatModel: string
  create(harness: Harness): Promise<{
    readonly canSteer: boolean
    readonly canDeleteHistory: boolean
    failNextModelPick(): void
  }>
}

const shapes: readonly RuntimeShape[] = [
  {
    name: 'Codex fake',
    id: 'codex-queue-test' as RuntimeId,
    initialPrompt: 'initial turn',
    approvalGated: true,
    firstSeatModel: 'gpt-5.6-sol',
    fallbackSeatModel: 'gpt-5.5',
    async create(harness) {
      const home = tempDir('hd-queue-codex-home-')
      let failNextModelPick = false
      const runtime = new CodexRuntime({
        id: this.id,
        name: 'Codex Queue Test',
        binaryPath: CODEX_FAKE,
        codexHome: home,
        clientName: 'harnessdesk-test',
        env: { HARNESSDESK_CODEX_PROCESS_GROUP: randomUUID(), HARNESSDESK_CODEX_GENERATION: '0', FAKE_CODEX_ADDITIONAL_MODEL: 'gpt-5.6-sol' },
      })
      harness.host.register(runtime)
      await runtime.start()
      const createSession = runtime.createSession.bind(runtime)
      runtime.createSession = async (...args) => {
        const forceReadbackMismatch = failNextModelPick && args[0].model !== undefined
        if (forceReadbackMismatch) failNextModelPick = false
        const session = await createSession({ ...args[0], ...(forceReadbackMismatch ? { model: 'gpt-5.5' } : {}) })
        const setOption = session.setOption.bind(session)
        session.setOption = async (id, value) => {
          if (id === 'model' && forceReadbackMismatch) {
            // Arrives after registration: housekeeping alone does not use a seat.
            const record = harness.host.registry.get(this.id, session.id)!
            record.session = { ...record.session, turns: [{ id: 'notice:housekeeping' as never,
              status: 'completed', items: [{ type: 'notice', id: 'housekeeping' as never,
                text: 'Tools are ready.' }] }] }
            return
          }
          await setOption(id, value)
        }
        return session
      }
      return {
        canSteer: runtime.info.capabilities.steer,
        canDeleteHistory: runtime.info.capabilities.deleteHistory,
        failNextModelPick: () => { failNextModelPick = true },
      }
    },
  },
  {
    name: 'ACP fake',
    id: 'acp-queue-test' as RuntimeId,
    initialPrompt: 'slow initial turn',
    approvalGated: false,
    firstSeatModel: 'large',
    fallbackSeatModel: 'small',
    async create(harness) {
      const home = tempDir('hd-queue-acp-home-')
      let failNextModelPick = false
      const runtime = new AcpRuntime({
        id: this.id,
        name: 'ACP Queue Test',
        command: process.execPath,
        args: [ACP_FAKE],
        env: { FAKE_ACP_STORE: join(home, 'sessions.json') },
      })
      harness.host.register(runtime)
      await runtime.start()
      const createSession = runtime.createSession.bind(runtime)
      runtime.createSession = async (...args) => {
        const forceReadbackMismatch = failNextModelPick && args[0].model !== undefined
        if (forceReadbackMismatch) failNextModelPick = false
        const session = await createSession({ ...args[0], ...(forceReadbackMismatch ? { model: 'small' } : {}) })
        const setOption = session.setOption.bind(session)
        session.setOption = async (id, value) => {
          if (id === 'model' && forceReadbackMismatch) return
          await setOption(id, value)
        }
        return session
      }
      return {
        canSteer: runtime.info.capabilities.steer,
        canDeleteHistory: runtime.info.capabilities.deleteHistory,
        failNextModelPick: () => { failNextModelPick = true },
      }
    },
  },
]

const queueOf = (client: Client, id: string): SessionQueue | null => {
  for (let index = client.events.length - 1; index >= 0; index -= 1) {
    const event = client.events[index]
    if (event?.type === 'session/queue' && String(event.sessionId) === id) return event.queue
  }
  return null
}

const busy = async (client: Client, shape: RuntimeShape): Promise<Session> => {
  const session = (await client.call('session/create', {
    runtime: shape.id,
    options: { cwd: '/w' },
  })) as Session
  await client.call('turn/send', {
    runtime: shape.id,
    sessionId: session.id,
    input: [{ type: 'text', text: shape.initialPrompt }],
  })
  await client.until(() => client.events.some((event) =>
    event.type === 'turn/started' && String(event.sessionId) === String(session.id),
  ))
  return session
}

const queue = async (client: Client, shape: RuntimeShape, session: Session, input: UserContent[]) =>
  client.call('turn/queue', { runtime: shape.id, sessionId: session.id, input })

const resolveApproval = async (client: Client, shape: RuntimeShape, session: Session): Promise<void> => {
  if (!shape.approvalGated) return
  await client.until(() => client.events.some((event) =>
    event.type === 'approval/requested' && String(event.approval.sessionId) === String(session.id),
  ))
  const event = client.events.find((candidate): candidate is Extract<AgentEvent, { type: 'approval/requested' }> =>
    candidate.type === 'approval/requested' && String(candidate.approval.sessionId) === String(session.id),
  )!
  assert.equal(event.approval.type, 'command')
  const approval = event.approval as CommandApproval
  const option = approval.options[0]
  assert.ok(option, 'the scripted command asks for a choice')
  await client.call('approval/respond', {
    runtime: shape.id,
    sessionId: session.id,
    approvalId: approval.id,
    decision: { type: 'option', optionId: option.id },
  })
}

for (const shape of shapes) {
  test(`host queue contract on ${shape.name}`, async (t: TestContext) => {
    const harness = await start()
    t.after(() => stop(harness))
    const runtimeShape = await shape.create(harness)
    const client = await Client.connect(harness.server)
    t.after(() => client.close())

    await t.test('edits in place, preserving identity, position, held state, and attachments', async () => {
      const session = await busy(client, shape)
      const inputs: UserContent[][] = [
        [{ type: 'text', text: 'before' }],
        [{ type: 'text', text: 'old words' }, { type: 'mention', name: 'a.ts', path: '/w/a.ts' }],
        [{ type: 'text', text: 'after' }],
      ]
      const ids: string[] = []
      for (const input of inputs) {
        ids.push((await queue(client, shape, session, input) as { queuedId: string }).queuedId)
      }
      await client.until(() => queueOf(client, String(session.id))?.messages.length === 3)
      const record = harness.host.registry.get(shape.id, sessionId(String(session.id)))!
      harness.host.registry.pauseQueue(record, 'Held for cross-runtime edit proof.')
      const before = record.queue.messages[1]!
      const eventsBefore = client.events.filter((event) => event.type === 'session/queue' && String(event.sessionId) === String(session.id)).length
      const replacement: UserContent[] = [
        { type: 'text', text: 'revised words' },
        { type: 'mention', name: 'b.ts', path: '/w/b.ts' },
      ]
      await client.call('turn/queue/update', { runtime: shape.id, sessionId: session.id, id: ids[1], input: replacement })
      await client.until(() => queueOf(client, String(session.id))?.messages[1]?.input[0]?.type === 'text' &&
        (queueOf(client, String(session.id))?.messages[1]?.input[0] as { text?: string }).text === 'revised words')
      const after = record.queue.messages[1]!
      assert.equal(after.id, before.id)
      assert.equal(after.queuedAt, before.queuedAt)
      assert.equal(after.state, before.state)
      assert.deepEqual(after.input.map((part) => part.type === 'text'
        ? { type: part.type, text: part.text }
        : part.type === 'mention'
          ? { type: part.type, name: part.name, path: part.path }
          : { type: part.type }), replacement)
      assert.equal(record.queue.status, 'paused')
      assert.deepEqual(record.queue.messages.map((message) => message.input[0]?.type === 'text' ? message.input[0].text : ''), ['before', 'revised words', 'after'])
      assert.equal(client.events.filter((event) => event.type === 'session/queue' && String(event.sessionId) === String(session.id)).length, eventsBefore + 1)

      await assert.rejects(client.call('turn/queue/update', {
        runtime: shape.id, sessionId: session.id, id: 'missing-id', input: replacement,
      }), (error: Error & { code?: string }) => error.code === 'methodFailed' && /no longer waiting/i.test(error.message))
      const emptyError = await client.call('turn/queue/update', {
        runtime: shape.id, sessionId: session.id, id: ids[0], input: [],
      }).then(() => null, (error: Error & { code?: string }) => error)
      assert.ok(emptyError)
      assert.equal(emptyError.code, 'badRequest')
      assert.match(emptyError.message, /content item/i)

      harness.host.registry.markSending(record)
      await assert.rejects(client.call('turn/queue/update', {
        runtime: shape.id, sessionId: session.id, id: ids[0], input: replacement,
      }), (error: Error & { code?: string }) => error.code === 'methodFailed' && /being delivered/i.test(error.message))
    })

    await t.test('queue cap refusal is typed and leaves the message to the renderer', async () => {
      const session = await busy(client, shape)
      for (let index = 0; index < QUEUE_LIMIT; index += 1) {
        await queue(client, shape, session, [{ type: 'text', text: `queued ${index}` }])
      }
      await client.until(() => queueOf(client, String(session.id))?.messages.length === QUEUE_LIMIT)
      const refusal = await queue(client, shape, session, [{ type: 'text', text: 'newer draft stays in the composer' }])
        .then(() => null, (error: Error & { code?: string }) => error)
      assert.ok(refusal)
      assert.equal(refusal.code, 'methodFailed')
      assert.equal(refusal.message, `${QUEUE_LIMIT} messages are already waiting for this conversation. Send or clear some first.`)
      assert.equal(queueOf(client, String(session.id))?.messages.length, QUEUE_LIMIT)
    })

    await t.test('an edit saved after delivery is refused', async () => {
      const session = await busy(client, shape)
      const id = (await queue(client, shape, session, [{ type: 'text', text: 'original delivered before Save' }]) as { queuedId: string }).queuedId
      await client.until(() => queueOf(client, String(session.id))?.messages.length === 1)
      await resolveApproval(client, shape, session)
      // ACP's scripted slow turn deliberately reports completion later than
      // Codex's approval-gated turn; wait on host events, never elapsed time.
      await client.until(() => queueOf(client, String(session.id))?.messages.length === 0, 15_000, 'queue drain after runtime turn completion')
      const record = harness.host.registry.get(shape.id, sessionId(String(session.id)))!
      await assert.rejects(client.call('turn/queue/update', {
        runtime: shape.id,
        sessionId: session.id,
        id,
        input: [{ type: 'text', text: 'changed after delivery' }],
      }), (error: Error & { code?: string }) => error.code === 'methodFailed' && /no longer waiting/i.test(error.message))
      assert.ok(record.session.turns.flatMap((turn) => turn.items).some((item) =>
        item.type === 'userMessage' && item.content.some((part) => part.type === 'text' && part.text.includes('original delivered before Save')),
      ), 'the original words reached the runtime before update was refused')
    })

    await t.test('steer follows declared capabilities and unsupported host steer is a typed refusal', async () => {
      const session = await busy(client, shape)
      if (runtimeShape.canSteer) {
        await client.call('turn/steer', { runtime: shape.id, sessionId: session.id, input: [{ type: 'text', text: 'can steer' }] })
      } else {
        const refusal = await client.call('turn/steer', {
          runtime: shape.id, sessionId: session.id, input: [{ type: 'text', text: 'must be recoverable' }],
        }).then(() => null, (error: Error & { code?: string }) => error)
        assert.ok(refusal)
        assert.equal(refusal.code, 'methodFailed')
        assert.match(refusal.message, /cannot steer a running turn/i)
      }
    })

    await t.test('session removal reports deletion truthfully when a seat is passed over', async () => {
      const work = tempDir('hd-queue-seat-work-')
      await client.call('workspace/open', { path: work })
      const preference = `${shape.id}=${shape.firstSeatModel}, ${shape.id}=${shape.fallbackSeatModel}`
      const agentDir = join(harness.stateDir, 'agents', 'reviewer')
      await mkdir(agentDir, { recursive: true })
      await writeFile(join(agentDir, 'AGENT.md'),
        `---\nname: Reviewer\npermission: read\nprefer: [${preference}]\n---\nRead the diff.\n`,
        'utf8',
      )
      runtimeShape.failNextModelPick()
      const eventStart = client.events.length
      const kept = await client.call('agent/seat', { id: 'reviewer', cwd: work }) as Session
      assert.equal(kept.runtime, shape.id)
      const opened = client.events.slice(eventStart).filter((event): event is Extract<AgentEvent, { type: 'session/started' }> =>
        event.type === 'session/started' && event.session.runtime === shape.id,
      )
      assert.equal(opened.length, 2, 'the failed pick was discarded and the next candidate was kept')
      const passedId = opened[0]!.session.id
      await client.until(() => client.notifications.some((notification) =>
        'method' in notification && notification.method === 'session/removed' &&
        String(notification.params.sessionId) === String(passedId),
      ))
      const removed = client.notifications.find((notification) =>
        'method' in notification && notification.method === 'session/removed' &&
        String(notification.params.sessionId) === String(passedId),
      )
      assert.ok(removed && 'method' in removed && removed.method === 'session/removed')
      assert.equal(removed.params.deleted, runtimeShape.canDeleteHistory,
        runtimeShape.canDeleteHistory
          ? 'the adapter declared deletion and removed the passed-over conversation'
          : 'the adapter cannot delete, so the host archived the passed-over conversation')
    })
  })
}
