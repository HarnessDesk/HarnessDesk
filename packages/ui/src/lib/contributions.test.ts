import { describe, expect, it } from 'vitest'

import {
  contributionId,
  pluginInstanceId,
  runtimeId,
  sessionId,
  sessionKey,
  turnId,
  type CapabilityContribution,
  type CapabilityScope,
} from '@harnessdesk/protocol'

import { contributionsHere, offeredHere, scopeHere } from './contributions'
import { emptySnapshot, type AppSnapshot } from '../state/snapshot'

/**
 * Where a contribution is offered.
 *
 * The renderer is pushed every contribution whatever its scope, so "what may be
 * offered here" is a question it has to ask rather than a list it is handed.
 */

const command = (id: string, scope: CapabilityScope): CapabilityContribution =>
  ({
    kind: 'command',
    id: contributionId(id),
    owner: pluginInstanceId('p#1'),
    revision: 0,
    scope,
    name: id,
    description: `Run ${id}`,
  }) satisfies CapabilityContribution

const snapshot = (overrides: Partial<AppSnapshot> = {}): AppSnapshot => ({
  ...emptySnapshot(),
  ...overrides,
})

describe('the scope the window is asking about', () => {
  it('takes the agent and the conversation from the key, not the app-wide runtime', () => {
    const scope = scopeHere(
      snapshot({ activeRuntime: runtimeId('codex'), workspace: { path: '/repo', name: 'repo' } as AppSnapshot['workspace'] }),
      sessionKey('claude', 's1'),
    )
    // The app's active runtime is codex; this conversation is claude's. Pairing
    // the two would ask about a conversation that never existed.
    expect(scope).toEqual({ workspaceRoot: '/repo', runtime: 'claude', sessionId: 's1' })
  })

  it('names no conversation for a draft, and falls back to the agent it would start as', () => {
    const scope = scopeHere(snapshot({ activeRuntime: runtimeId('codex') }), null)
    expect(scope.runtime).toBe('codex')
    expect(scope.sessionId).toBeUndefined()
  })
})

describe('what applies here', () => {
  const key = sessionKey('codex', 's1')
  const base = snapshot({
    activeRuntime: runtimeId('codex'),
    workspace: { path: '/repo', name: 'repo' } as AppSnapshot['workspace'],
  })

  it('offers a global contribution and withholds one scoped to another conversation', () => {
    const offered = contributionsHere(
      [
        command('everywhere', { kind: 'global' }),
        command('elsewhere', { kind: 'session', sessionId: sessionId('s9') }),
      ],
      scopeHere(base, key),
    )
    // The control and the finding in one list: a filter that dropped both would
    // pass an "is not offered" assertion without meaning anything.
    expect(offered.map((entry) => String(entry.id))).toEqual(['everywhere'])
  })

  it('offers one scoped to this conversation, this project and this agent', () => {
    const offered = contributionsHere(
      [
        command('this-session', { kind: 'session', sessionId: sessionId('s1') }),
        command('this-workspace', { kind: 'workspace', root: '/repo' }),
        command('this-agent', { kind: 'agent', runtime: runtimeId('codex') }),
        command('other-workspace', { kind: 'workspace', root: '/elsewhere' }),
        command('other-agent', { kind: 'agent', runtime: runtimeId('claude') }),
      ],
      scopeHere(base, key),
    )
    expect(offered.map((entry) => String(entry.id))).toEqual(['this-session', 'this-workspace', 'this-agent'])
  })

  it('withholds a turn-scoped contribution, which no call from the window could match', () => {
    // `command/run` and `context/resolve` name a conversation and never a turn,
    // so the host could not find it either. See `scopeHere`.
    const offered = contributionsHere(
      [command('in-a-turn', { kind: 'turn', sessionId: sessionId('s1'), turnId: turnId('t1') })],
      scopeHere(base, key),
    )
    expect(offered).toEqual([])
  })

  it('offers a contribution that carries no scope at all, rather than losing it', () => {
    const malformed = { ...command('no-scope', { kind: 'global' }), scope: undefined } as unknown as CapabilityContribution
    expect(contributionsHere([malformed], scopeHere(base, key))).toHaveLength(1)
  })

  it('reads the snapshot and the key together', () => {
    const withContributions = snapshot({
      ...base,
      contributions: [command('everywhere', { kind: 'global' }), command('elsewhere', { kind: 'session', sessionId: sessionId('s9') })],
    })
    expect(offeredHere(withContributions, key).map((entry) => String(entry.id))).toEqual(['everywhere'])
  })
})
