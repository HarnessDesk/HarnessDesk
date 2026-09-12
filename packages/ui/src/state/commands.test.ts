import { describe, expect, test } from 'vitest'

import { sessionKey, type ConfigOption, type Session } from '@harnessdesk/protocol'

import { emptyLayout } from './layout'

import { BUILTIN_COMMANDS, availableCommands, matchCommands, optionCommands } from './commands'
import type { AppSnapshot, AppStore } from './store'

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

/**
 * Where a contributed command is offered.
 *
 * A contribution carries a scope, and the palette was pushed every one of them
 * regardless — so a command narrowed to one conversation was listed in all of
 * them, and `command/run` would then not find it, because the host applies the
 * scope the palette did not.
 */
describe('the scope a contribution declares', () => {
  const command = (name: string, scope: unknown) => ({
    kind: 'command',
    id: name,
    owner: 'p#1',
    revision: 1,
    scope,
    name,
    description: `Run ${name}`,
  })

  const panel = (label: string, scope: unknown) => ({
    kind: 'ui',
    id: label,
    owner: 'p#1',
    revision: 1,
    scope,
    slot: 'sidebar.panel',
    label,
    order: 0,
    component: 'hd.panel',
    mounts: ['right'],
  })

  /** Conversation `s1` of agent `codex`, focused. */
  const inConversation = (contributions: readonly unknown[]): AppSnapshot => {
    const session = {
      id: 's1',
      runtime: 'codex',
      cwd: '/w',
      status: { type: 'idle' },
      createdAt: 0,
      updatedAt: 0,
      turns: [],
      itemsLoaded: true,
    } as unknown as Session
    const key = sessionKey('codex', 's1')
    return snapshot({
      activeSessionKey: key,
      activeSessionId: session.id as never,
      sessions: new Map([[key, session]]),
      contributions,
    } as never)
  }

  test('keeps a command scoped to another conversation out of the palette', () => {
    const names = availableCommands(
      inConversation([
        command('everywhere', { kind: 'global' }),
        command('elsewhere', { kind: 'session', sessionId: 's9' }),
      ]),
    ).map((entry) => entry.name)
    // The control, in the same reading: an unscoped command is still offered,
    // so the absence below is a scope being applied and not an empty list.
    expect(names).toContain('everywhere')
    expect(names).not.toContain('elsewhere')
  })

  test("keeps another conversation's panel out of the palette too", () => {
    const names = availableCommands(
      inConversation([
        panel('Coverage', { kind: 'global' }),
        panel('Elsewhere', { kind: 'session', sessionId: 's9' }),
      ]),
    ).map((entry) => entry.name)
    expect(names).toContain('coverage')
    expect(names).not.toContain('elsewhere')
  })

  test('offers one scoped to the conversation in front of you', () => {
    const names = availableCommands(
      inConversation([command('here', { kind: 'session', sessionId: 's1' })]),
    ).map((entry) => entry.name)
    expect(names).toContain('here')
  })
})

/**
 * Back and forward, as entries in the shared list.
 *
 * The window controls' two arrows were the only callers of `navigateBack` and
 * `navigateForward`, and the header folds them under 520px (#254). A command
 * is the route that no width can take — the palette and the composer read this
 * list, so one entry is both. What makes the entry worth anything is the verb
 * behind it: a command registered against nothing would satisfy "the palette
 * offers Back" and do nothing when chosen, so these run it and watch.
 */
describe('back and forward', () => {
  const wherever = (overrides: Partial<AppSnapshot>): AppSnapshot =>
    snapshot(overrides as Partial<AppSnapshot>)

  const spy = () => {
    const went: string[] = []
    const store = {
      navigateBack: async () => void went.push('back'),
      navigateForward: async () => void went.push('forward'),
    } as unknown as AppStore
    return { store, went }
  }

  const named = (name: string, snap: AppSnapshot) =>
    availableCommands(snap).find((command) => command.name === name)

  test('are offered once there is somewhere to go', () => {
    const names = availableCommands(
      wherever({ navCanBack: true, navCanForward: true } as Partial<AppSnapshot>),
    ).map((command) => command.name)
    expect(names).toContain('back')
    expect(names).toContain('forward')
  })

  test('and step the history rather than merely existing', async () => {
    const snap = wherever({ navCanBack: true, navCanForward: true } as Partial<AppSnapshot>)

    const back = spy()
    const backCommand = named('back', snap)
    expect(backCommand?.kind.type).toBe('action')
    if (backCommand?.kind.type !== 'action') return
    await backCommand.kind.run(back.store, '')
    expect(back.went).toEqual(['back'])

    const forward = spy()
    const forwardCommand = named('forward', snap)
    if (forwardCommand?.kind.type !== 'action') return
    await forwardCommand.kind.run(forward.store, '')
    // Each reaches its own verb: one wired to the other would pass a test that
    // only asked whether *something* was called.
    expect(forward.went).toEqual(['forward'])
  })

  test('and are withdrawn, each on its own, when that way is a dead end', () => {
    const onlyBack = availableCommands(
      wherever({ navCanBack: true, navCanForward: false } as Partial<AppSnapshot>),
    ).map((command) => command.name)
    expect(onlyBack).toContain('back')
    expect(onlyBack).not.toContain('forward')

    const neither = availableCommands(wherever({})).map((command) => command.name)
    expect(neither).not.toContain('back')
    expect(neither).not.toContain('forward')
    // Control: withdrawing those two did not empty the list.
    expect(neither).toContain('new')
  })
})
