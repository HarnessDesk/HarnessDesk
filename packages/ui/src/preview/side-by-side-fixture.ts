import { runtimeId, sessionKey, type Session, type SessionId, type SessionKey, type TeamPeerInfo } from '@harnessdesk/protocol'

import type { AppSnapshot, AppStore } from '../state/store'
import { previewStore } from './harness'

export const SIDE_BY_SIDE_MEMBERS = [
  { runtime: runtimeId('codex'), id: 'c1', nickname: 'Alpha', agent: 'Assistant A', model: 'Model A' },
  { runtime: runtimeId('claude'), id: 'k1', nickname: 'Beta', agent: 'Assistant B', model: 'Model B' },
  { runtime: runtimeId('cursor'), id: 'x1', nickname: 'Gamma', agent: 'Assistant C', model: 'Model C' },
  { runtime: runtimeId('codex'), id: 's1', nickname: 'Delta', agent: 'Assistant D', model: 'Model D' },
] as const
/** What each member answered the shared brief with, so every tile reads as a member at work rather than an empty conversation. */
const ANSWERS = [
  'Retrying on a 502 inside the client keeps the caller simple; the test covers three attempts.',
  'I moved the retry into a small wrapper so every request path gets it, with a budget of three.',
  'The retry belongs at the call site that knows the request is safe to repeat; I added it there.',
  'Three attempts with a growing pause, and a 502 after the last one surfaces as it did before.',
] as const

const exchange = (key: string, index: number): Session['turns'] =>
  [
    {
      id: `${key}-t1`,
      status: 'completed',
      items: [
        { id: `${key}-u`, type: 'userMessage', content: [{ type: 'text', text: 'Make the client retry a 502 before giving up.' }] },
        { id: `${key}-a`, type: 'assistantMessage', phase: 'final', text: ANSWERS[index] },
      ],
    },
  ] as unknown as Session['turns']

export const SIDE_BY_SIDE_KEYS = SIDE_BY_SIDE_MEMBERS.map((member) => sessionKey(member.runtime, member.id as SessionId)) as SessionKey[]

export const sideBySideStore = (): AppStore => {
  const base = previewStore()
  const snapshot = base.getSnapshot()
  const sessions = new Map<SessionKey, Session>()
  SIDE_BY_SIDE_MEMBERS.forEach((member, index) => {
    const key = SIDE_BY_SIDE_KEYS[index]!
    const prior = snapshot.sessions.get(key)
    if (!prior) throw new Error(`Missing preview conversation for ${member.nickname}`)
    sessions.set(key, {
      ...prior,
      title: `${member.nickname} conversation`,
      // Keep the catalogue's tile states about side by side itself. The
      // shared base fixture carries an unrelated active-goal bar, whose
      // dismiss action belongs to a separate preview story.
      goal: null,
      settings: {
        ...prior.settings,
        cwd: prior.cwd,
        model: `model-${String.fromCharCode(97 + index)}`,
        agent: member.agent,
      },
      // The preview's own conversations carry real model names in their model
      // option; the tiles' frames are public, so the option is left out and
      // every tile's composer reads alike.
      options: (prior.options ?? []).filter((option) => option.category !== 'model'),
      turns: exchange(member.id, index),
      itemsLoaded: true,
    })
  })
  const runtimes = snapshot.runtimes.map((entry, index) => ({
    ...entry,
    name: `Assistant ${String.fromCharCode(65 + index)}`,
    presentation: { ...entry.presentation, name: `Assistant ${String.fromCharCode(65 + index)}` },
  }))
  const models = snapshot.models.slice(0, 1).map((model) => ({
    ...model,
    id: 'model-a',
    displayName: 'Model A',
    description: 'Preview model',
  }))
  const own = previewStore({ ...snapshot, sessions, runtimes, models } as Partial<AppSnapshot>)
  const peers: readonly TeamPeerInfo[] = SIDE_BY_SIDE_MEMBERS.map((member) => ({
    runtime: member.runtime,
    sessionId: member.id,
    title: `${member.nickname} conversation`,
    agent: member.agent,
    nickname: member.nickname,
    model: member.model,
    busy: false,
    here: true,
    inbound: 'accept',
  }))
  return new Proxy(own, {
    get(target, property, receiver) {
      if (property === 'teamPeers') return async () => peers
      return Reflect.get(target, property, receiver)
    },
  })
}
