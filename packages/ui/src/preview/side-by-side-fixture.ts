import { runtimeId, sessionKey, type Session, type SessionId, type SessionKey, type TeamPeerInfo } from '@harnessdesk/protocol'

import type { AppSnapshot, AppStore } from '../state/store'
import { previewStore } from './harness'

export const SIDE_BY_SIDE_MEMBERS = [
  { runtime: runtimeId('codex'), id: 'c1', nickname: 'Alpha', agent: 'Assistant A', model: 'Model A' },
  { runtime: runtimeId('claude'), id: 'k1', nickname: 'Beta', agent: 'Assistant B', model: 'Model B' },
  { runtime: runtimeId('cursor'), id: 'x1', nickname: 'Gamma', agent: 'Assistant C', model: 'Model C' },
  { runtime: runtimeId('codex'), id: 's1', nickname: 'Delta', agent: 'Assistant D', model: 'Model D' },
] as const
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
      turns: [],
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
