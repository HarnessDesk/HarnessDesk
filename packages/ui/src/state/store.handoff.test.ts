import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  itemId,
  runtimeId,
  sessionId,
  sessionKey,
  turnId,
  type HostMethodName,
  type Session,
} from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * Carrying a conversation to another agent.
 *
 * Three things went wrong here in the real app, and each one lost work
 * silently: a packet the agent could no longer serve was replaced by nothing
 * and the message went anyway; "New session" kept the last hand-off; and
 * clicking the chip to read the original threw the hand-off away.
 */

const SOURCE = runtimeId('codex')
const TARGET = runtimeId('claude-code')
const ID = sessionId('s-1')
const KEY = sessionKey(SOURCE, ID)

const conversation = (): Session =>
  ({
    id: ID,
    runtime: SOURCE,
    cwd: '/w',
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    itemsLoaded: true,
    turns: [
      {
        id: turnId('t-1'),
        status: 'completed',
        items: [
          { id: itemId('u1'), type: 'userMessage', content: [{ type: 'text', text: 'Build pong' }] },
          { id: itemId('a1'), type: 'assistantMessage', phase: 'final', text: 'The board is drawn.' },
        ],
      },
    ],
  }) as unknown as Session

let store: AppStore
let answers: Partial<Record<HostMethodName, unknown>>
let refused: Partial<Record<HostMethodName, string>>

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  answers = {}
  refused = {}
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName) => {
    if (refused[method]) throw new Error(refused[method])
    return answers[method] ?? null
  }) as never)
})

const handoff = () => ({
  runtime: SOURCE,
  sessionId: ID,
  carry: 'summary' as const,
  agentName: 'OpenAI Codex',
  title: 'Build pong',
  cwd: '/w',
})

describe('the hand-off packet', () => {
  it('is built from the agent’s own read when it can serve one', async () => {
    answers['session/read'] = conversation()
    expect(await store.handoffPacket(handoff())).toContain('## Goal\nBuild pong')
  })

  it('falls back to the conversation this window holds when the agent cannot', async () => {
    // An ACP agent restarted by a catalogue refresh keeps no idle session,
    // and the transcript is still on screen — so it is what travels.
    answers['session/read'] = conversation()
    answers['session/resume'] = conversation()
    await store.openSession(ID, { runtime: SOURCE })
    expect(store.getSnapshot().sessions.get(KEY)?.turns).toHaveLength(1)

    refused['session/read'] = 'no stored session s-1'
    const packet = await store.handoffPacket(handoff())
    expect(packet).toContain('## Goal\nBuild pong')
    expect(packet).toContain('OpenAI Codex answered: The board is drawn.')
  })

  it('has nothing to say when neither the agent nor the window has the conversation', async () => {
    refused['session/read'] = 'no stored session s-1'
    expect(await store.handoffPacket(handoff())).toBeNull()
    expect(store.getSnapshot().notices.at(-1)?.message).toContain('no stored session')
  })

  it('prefers whichever of the two knows more, not whichever answered', async () => {
    answers['session/read'] = conversation()
    answers['session/resume'] = conversation()
    await store.openSession(ID, { runtime: SOURCE })
    // The agent's store has the session but has forgotten what was in it.
    answers['session/read'] = { ...conversation(), turns: [] }
    expect(await store.handoffPacket(handoff())).toContain('The board is drawn.')
  })
})

describe('the hand-off chip and the draft it belongs to', () => {
  beforeEach(() => {
    answers['session/read'] = conversation()
    answers['session/resume'] = conversation()
  })

  it('is not carried into a conversation that was asked to be empty', async () => {
    await store.openSession(ID, { runtime: SOURCE })
    await store.handOff(TARGET, 'summary')
    expect(store.getSnapshot().draftHandoff?.sessionId).toBe(ID)

    store.newDraft()
    expect(store.getSnapshot().draftHandoff).toBeNull()
  })

  it('survives reading its own source, and comes back with the next draft', async () => {
    await store.openSession(ID, { runtime: SOURCE })
    await store.handOff(TARGET, 'summary')

    // What the chip's own link does.
    await store.openSession(ID, { runtime: SOURCE })
    expect(store.getSnapshot().draftHandoff).toBeNull()

    store.newDraft()
    expect(store.getSnapshot().draftHandoff?.sessionId).toBe(ID)
    expect(store.getSnapshot().draftHandoff?.carry).toBe('summary')
  })

  it('is dropped for good when the × is pressed', async () => {
    await store.openSession(ID, { runtime: SOURCE })
    await store.handOff(TARGET, 'transcript')
    store.clearDraftHandoff()
    store.newDraft()
    expect(store.getSnapshot().draftHandoff).toBeNull()
  })

  it('starts the session it becomes in the source conversation’s folder', async () => {
    await store.openSession(ID, { runtime: SOURCE })
    await store.handOff(TARGET, 'summary')
    expect(store.getSnapshot().draftHandoff?.cwd).toBe('/w')

    // The draft is sent: the session must be created where the packet
    // points, not in whatever workspace happens to be selected.
    answers['session/create'] = { ...conversation(), id: sessionId('s-2'), runtime: TARGET }
    await store.queue([{ type: 'text', text: 'Take it from here.' }])
    const create = vi.mocked(store.transport.request).mock.calls.find(([method]) => method === 'session/create')
    expect(create?.[1]).toMatchObject({ runtime: TARGET, options: { cwd: '/w' } })
  })

  it('switches agent when there is no conversation to carry', async () => {
    // The usage banner offers this over an empty pane, labelled "Switch to …".
    expect(store.getSnapshot().activeSessionKey).toBeNull()
    await store.handOff(TARGET)
    expect(store.getSnapshot().activeRuntime).toBe(TARGET)
    expect(store.getSnapshot().draftHandoff).toBeNull()
  })
})
