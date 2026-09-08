import { describe, expect, test } from 'vitest'

import { sessionKey, type ConfigOption, type Session } from '@harnessdesk/protocol'

import { emptyLayout } from './layout'

import { BUILTIN_COMMANDS, availableCommands, matchCommands, optionCommands } from './commands'
import type { AppSnapshot } from './store'

/**
 * Command resolution. The property that matters most: a plugin-contributed
 * command is indistinguishable from a built-in one at the point of use.
 */

const snapshot = (overrides: Partial<AppSnapshot> = {}): AppSnapshot =>
  ({
    status: 'open',
    runtimes: [],
    activeRuntime: null,
    health: null,
    account: null,
    limits: null,
    models: [],
    runtimeOptions: [],
    sessions: new Map(),
    history: [],
    historyLoading: false,
    historyCursor: null,
    layout: emptyLayout(),
    activeSessionKey: null,
    activeSessionId: null,
    loadingSessions: new Set(),
    approvals: [],
    notices: [],
    worktrees: [],
    workspaces: [],
    workspace: null,
    skills: [],
    plugins: [],
    contributions: [],
    detailsTab: null,
    sidebarCollapsed: false,
    theme: 'system',
    fatal: null,
    ...overrides,
  }) as AppSnapshot

/** A session whose runtime declared two controls the interface has never heard of. */
const withOptions = (options: readonly ConfigOption[]): AppSnapshot => {
  const session = {
    id: 's1',
    runtime: 'r',
    cwd: '/w',
    status: { type: 'idle' },
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    itemsLoaded: true,
    options,
  } as unknown as Session
  const key = sessionKey(session.runtime, session.id)
  return snapshot({
    activeSessionKey: key,
    activeSessionId: session.id as never,
    sessions: new Map([[key, session]]),
  })
}

const OPTIONS: ConfigOption[] = [
  {
    type: 'select',
    id: 'flavour',
    label: 'Flavour',
    description: 'Pick a flavour',
    currentValue: 'mild',
    choices: [
      { value: 'mild', label: 'Mild' },
      { value: 'hot', label: 'Hot', description: 'Spicy' },
    ],
  },
  { type: 'boolean', id: 'shout', label: 'Shout', currentValue: false },
]

describe('optionCommands', () => {
  test('every declared option becomes a slash command, named by its id', () => {
    const names = optionCommands(withOptions(OPTIONS)).map((command) => command.name)
    expect(names).toEqual(['flavour', 'shout'])
  })

  test('a select opens a chooser listing the runtime’s choices with the current one marked', () => {
    const snap = withOptions(OPTIONS)
    const flavour = optionCommands(snap).find((command) => command.name === 'flavour')
    expect(flavour?.kind.type).toBe('choose')
    if (flavour?.kind.type !== 'choose') return
    expect(flavour.kind.choices(snap)).toEqual([
      { id: 'mild', label: 'Mild', selected: true },
      { id: 'hot', label: 'Hot', hint: 'Spicy', selected: false },
    ])
  })

  test('a toggle runs directly, and says which way it will flip', () => {
    const shout = optionCommands(withOptions(OPTIONS)).find((command) => command.name === 'shout')
    expect(shout?.kind.type).toBe('action')
    expect(shout?.description).toMatch(/^Turn on/)
  })

  test('no session, no option commands', () => {
    expect(optionCommands(snapshot())).toEqual([])
  })
})

describe('matchCommands', () => {
  test('prefix matches rank above substring matches', () => {
    const matched = matchCommands(BUILTIN_COMMANDS, 'n')
    expect(matched[0]?.name).toBe('new')
  })

  test('an empty query returns everything, unreordered', () => {
    expect(matchCommands(BUILTIN_COMMANDS, '')).toHaveLength(BUILTIN_COMMANDS.length)
  })

  test('descriptions are searchable, but rank last', () => {
    const matched = matchCommands(BUILTIN_COMMANDS, 'folder')
    expect(matched.map((c) => c.name)).toContain('workspace')
  })

  test('no match returns nothing rather than everything', () => {
    expect(matchCommands(BUILTIN_COMMANDS, 'zzzz')).toEqual([])
  })
})

describe('availableCommands', () => {
  test('session-scoped commands are hidden with no session open', () => {
    const names = availableCommands(snapshot()).map((command) => command.name)
    expect(names).not.toContain('fork')
    // Commands that work without a session stay available.
    expect(names).toContain('new')
    expect(names).toContain('workspace')
  })

  test('plugin commands appear beside built-ins, attributed to their plugin', () => {
    const withPlugin = snapshot({
      plugins: [
        {
          instanceId: 'deploy#1',
          identity: { id: 'deploy', name: 'Deploy', source: { kind: 'builtin' } },
          state: { type: 'active' },
          revision: 1,
          permissions: {
            workspace: { read: true, write: false },
            shell: false,
            network: { hosts: [] },
            agents: { invoke: false },
            ui: { contribute: false },
            secrets: [],
          },
          injects: [],
          provides: [],
          contributions: [],
          enabled: true,
        },
      ],
      contributions: [
        {
          kind: 'command',
          id: 'c1',
          owner: 'deploy#1',
          revision: 1,
          scope: { kind: 'global' },
          name: 'deploy',
          description: 'Ship it',
        },
      ],
    } as never)

    const deploy = availableCommands(withPlugin).find((command) => command.name === 'deploy')
    expect(deploy).toBeDefined()
    expect(deploy?.source).toBe('Deploy')
    expect(deploy?.kind.type).toBe('action')
  })
})
