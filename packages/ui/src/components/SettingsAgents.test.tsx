import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type {
  Account,
  AccountStatus,
  AcpRegistryAgentInfo,
  AgentTemplateInfo,
  InstallInfo,
  RuntimeInfo,
} from '@harnessdesk/protocol'
import { NO_CAPABILITIES } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AddAgents, RuntimesSection } from './SettingsAgents'

/**
 * Adding an agent from the interface — the door the audit found missing.
 *
 * The catalogue is the host's; the page renders what it is given and never
 * names a runtime of its own. What it owes the user: a template that cannot
 * be added says why with the install command beside the reason, a registered
 * one says so instead of offering itself again, and the custom form sends
 * exactly what was typed.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const CATALOG: AgentTemplateInfo[] = [
  {
    key: 'agent-one',
    name: 'Agent One',
    tagline: 'The one that works.',
    available: true,
    registered: false,
    requires: { command: 'one', found: true },
  },
  {
    key: 'agent-two',
    name: 'Agent Two',
    available: false,
    reason: 'two is not installed on this machine.',
    registered: false,
    requires: { command: 'two', found: false, installCommand: 'npm install -g two' },
  },
  {
    key: 'agent-three',
    name: 'Agent Three',
    available: true,
    registered: true,
  },
]

const mount = async (
  catalog: readonly AgentTemplateInfo[] = CATALOG,
  registryAgents: readonly AcpRegistryAgentInfo[] = [],
  addAgentImpl: () => Promise<string | null> = async () => 'agent-one',
): Promise<{
  store: AppStore
  agentCatalog: ReturnType<typeof vi.fn>
  addAgent: ReturnType<typeof vi.fn>
  acpRegistry: ReturnType<typeof vi.fn>
}> => {
  const agentCatalog = vi.fn(async () => catalog)
  const addAgent = vi.fn(addAgentImpl)
  const acpRegistry = vi.fn(async () => ({ agents: registryAgents, fetchedAt: 1 }))
  const snapshot: AppSnapshot = { ...emptySnapshot(), status: 'open' } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    agentCatalog,
    addAgent,
    acpRegistry,
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <AddAgents onBack={() => {}} onDone={() => {}} />
      </StoreProvider>,
    )
  })
  return { store, agentCatalog, addAgent, acpRegistry }
}

const button = (label: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll('button')].find((node) => node.textContent?.includes(label))

/** A form field, by the visible label `Field` points at it — the name a person reads. */
const byLabel = (text: string): string => {
  const label = [...document.body.querySelectorAll('label')].find((node) => node.textContent?.trim() === text)
  if (!label) throw new Error(`no label ${text}`)
  return `[id="${label.htmlFor}"]`
}

const type = (selector: string, value: string): void => {
  const field = document.body.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null
  if (!field) throw new Error(`no field ${selector}`)
  act(() => {
    const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('renders the catalogue with honesty per row', async () => {
  await mount()

  // Available: name, tagline, a live Add button.
  expect(document.body.textContent).toContain('Agent One')
  expect(document.body.textContent).toContain('The one that works.')

  // Unavailable: the reason and the way out, not a bare grey button.
  expect(document.body.textContent).toContain('two is not installed on this machine.')
  expect(document.body.textContent).toContain('npm install -g two')

  // Registered: said, not re-offered.
  expect(document.body.textContent).toContain('Added')
})

it('adds a template and re-reads the catalogue', async () => {
  const { agentCatalog, addAgent } = await mount()

  await act(async () => {
    button('Add')?.click()
  })

  expect(addAgent).toHaveBeenCalledWith({ template: 'agent-one' })
  // The page re-asks rather than guessing what changed.
  expect(agentCatalog).toHaveBeenCalledTimes(2)
})

it('a template that cannot be added has no live button', async () => {
  await mount()
  const buttons = [...document.body.querySelectorAll('button')].filter(
    (node) => node.textContent?.includes('Add') && !node.textContent.includes('agent'),
  )
  const disabled = buttons.filter((node) => node.disabled)
  expect(disabled.length).toBe(1)
})

it('sends the custom form as typed, arguments split by line', async () => {
  const { addAgent } = await mount()

  await act(async () => {
    button('Set up…')?.click()
  })
  type(byLabel('Name'), 'My Harness')
  type(byLabel('Command'), '/usr/local/bin/my-harness')
  type(byLabel('Arguments'), '--acp\n--config /tmp/x.yml\n')

  await act(async () => {
    button('Add runtime')?.click()
  })

  expect(addAgent).toHaveBeenCalledWith({
    custom: {
      name: 'My Harness',
      command: '/usr/local/bin/my-harness',
      args: ['--acp', '--config /tmp/x.yml'],
    },
  })
})

it('forgets what was typed when the custom form is cancelled', async () => {
  await mount()
  await act(async () => {
    button('Set up…')?.click()
  })
  type(byLabel('Name'), 'My Harness')
  type(byLabel('Command'), '/usr/local/bin/my-harness')
  await act(async () => {
    button('Cancel')?.click()
  })
  expect(document.body.querySelector('[role="dialog"][aria-label="Add a custom runtime"]')).toBeNull()
  await act(async () => {
    button('Set up…')?.click()
  })
  const name = document.body.querySelector(byLabel('Name')) as HTMLInputElement
  const command = document.body.querySelector(byLabel('Command')) as HTMLInputElement
  expect(name.value).toBe('')
  expect(command.value).toBe('')
})

it('says so, in the dialog, when adding fails', async () => {
  await mount(CATALOG, [], async () => null)
  await act(async () => {
    button('Set up…')?.click()
  })
  type(byLabel('Name'), 'My Harness')
  type(byLabel('Command'), '/usr/local/bin/my-harness')
  await act(async () => {
    button('Add runtime')?.click()
  })
  const dialog = document.body.querySelector('[role="dialog"][aria-label="Add a custom runtime"]')
  expect(dialog).not.toBeNull()
  const alert = dialog?.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('could not add it')
})

it('says so when adding throws', async () => {
  await mount(CATALOG, [], async () => {
    throw new Error('the command exited with 127')
  })
  await act(async () => {
    button('Set up…')?.click()
  })
  type(byLabel('Name'), 'My Harness')
  type(byLabel('Command'), 'nope')
  await act(async () => {
    button('Add runtime')?.click()
  })
  const alert = document.body.querySelector('[role="dialog"] [role="alert"]')
  expect(alert?.textContent).toContain('exited with 127')
})

/**
 * The ACP registry section: the protocol's own list, every entry shown. An
 * addable row speaks in the registry's words, a blocked one wears the reason
 * where the description would be, and a registered one is said rather than
 * re-offered — the same honesty the template rows hold to.
 */

const REGISTRY: AcpRegistryAgentInfo[] = [
  {
    id: 'goose',
    name: 'goose',
    version: '1.48.0',
    description: 'A local, extensible agent.',
    run: 'binary',
    integrity: 'sha256',
    available: true,
    registered: false,
  },
  {
    id: 'z-agent',
    name: 'Z Agent',
    version: '0.0.0-dev',
    description: 'Unverified binary agent.',
    run: 'binary',
    integrity: 'none',
    available: true,
    registered: false,
  },
  {
    id: 'fast-agent',
    name: 'fast-agent',
    version: '0.10.1',
    description: 'Multi-provider agent.',
    run: 'uvx',
    available: false,
    reason: 'Needs uvx (uv), which is not on PATH.',
    registered: false,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    version: '0.57.0',
    run: 'npx',
    available: true,
    registered: true,
  },
]

it('renders the registry with the same honesty per row', async () => {
  await mount(CATALOG, REGISTRY)

  expect(document.body.textContent).toContain('From the ACP registry')
  // Addable: the registry's own words under the name.
  expect(document.body.textContent).toContain('A local, extensible agent.')
  // Blocked: the reason where the description would be.
  expect(document.body.textContent).toContain('Needs uvx (uv), which is not on PATH.')
  // Registered: two Added chips now — the template's and Gemini's.
  expect(document.body.textContent).toContain('Gemini CLI')
  // Unverified binary build: carries the unverified badge on its cell.
  expect(document.body.textContent).toContain('Unverified')
  // Every entry is a plate card, compact — the card the transcript's cards
  // are, not a box drawn for the registry alone.
  const cells = REGISTRY.map((agent) =>
    [...document.body.querySelectorAll('[data-slot="card"]')].find((card) => card.textContent?.includes(agent.name)),
  )
  expect(cells.every(Boolean)).toBe(true)
  for (const cell of cells) {
    expect(cell?.getAttribute('data-variant')).toBe('plate')
    expect(cell?.getAttribute('data-spacing')).toBe('compact')
  }
})

it('adds a registry entry by its id and re-reads the registry', async () => {
  const { addAgent, acpRegistry } = await mount([], REGISTRY)

  // goose ships as a binary, so its button discloses the download before the
  // click — the label is the consent, not a surprise after it.
  await act(async () => {
    button('Download')?.click()
  })

  expect(addAgent).toHaveBeenCalledWith({ registry: { id: 'goose' } })
  expect(acpRegistry).toHaveBeenCalledTimes(2)
})

it('search appears with the long list and narrows it to the words a person knows', async () => {
  // Eight rows scan; the ninth is where the field earns its place.
  const many = [
    ...REGISTRY,
    ...Array.from({ length: 6 }, (_, index): AcpRegistryAgentInfo => ({
      id: `filler-${index}`,
      name: `Filler ${index}`,
      version: '1.0.0',
      run: 'npx',
      available: true,
      registered: false,
    })),
  ]
  await mount(CATALOG, many)

  type('input[aria-label="Search the ACP registry"]', 'extensible')
  expect(document.body.textContent).toContain('goose')
  expect(document.body.textContent).not.toContain('fast-agent')
  expect(document.body.textContent).not.toContain('Filler 3')
})

/**
 * The list itself: ten agents on one page, read as a management roster.
 *
 * What the page owes someone with that many is a way to see all of them at
 * once and a way to find one of them — so what needs attention is listed
 * first, each agent is one line saying who it is signed in as, a signed-out
 * one carries its Sign in on that line, and the line opens the agent's page,
 * where its accounts are.
 */

const runtime = (over: Record<string, unknown>): RuntimeInfo =>
  ({
    capabilities: { ...NO_CAPABILITIES, account: true },
    presentation: { name: String(over.name ?? over.id) },
    ...over,
  }) as unknown as RuntimeInfo

const signedIn = (accounts: readonly Partial<Account>[], flows: readonly string[]) =>
  ({
    accounts,
    signInMethods: flows.map((flow, index) => ({ id: `m${index}`, label: flow, flow })),
  }) as unknown as AccountStatus

const ROSTER = {
  runtimes: [
    runtime({
      id: 'alpha',
      name: 'Alpha',
      version: '1.2.3',
      presentation: { name: 'Alpha', tagline: 'The one with two accounts.' },
    }),
    runtime({
      id: 'alpha#2',
      name: 'Alpha',
      presentation: { name: 'Alpha' },
      slot: { agent: 'alpha', home: '/tmp/alpha-2', removable: true, canAdd: true },
    }),
    runtime({ id: 'beta', name: 'Beta', presentation: { name: 'Beta' } }),
    runtime({ id: 'gamma', name: 'Gamma', presentation: { name: 'Gamma' } }),
  ] as RuntimeInfo[],
  accountsByRuntime: {
    alpha: signedIn([{ kind: 'oauth', label: 'ada@example.com', email: 'ada@example.com', planType: 'Pro' }], ['browser']),
    'alpha#2': signedIn([{ kind: 'oauth', label: 'grace@example.com', email: 'grace@example.com', planType: 'Team' }], ['browser']),
    beta: signedIn([{ kind: 'apiKey', label: 'API key' }], ['apiKey']),
    gamma: signedIn([], ['browser']),
  },
  usage: [
    {
      runtime: 'alpha',
      account: 'ada@example.com',
      plan: 'Pro',
      lanes: [{ label: '5h', usedPercent: 30 }, { label: 'weekly', usedPercent: 73 }],
      reached: null,
    },
  ],
}

const mountList = async (
  over: Record<string, unknown> & { store?: Record<string, unknown> } = {},
): Promise<void> => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: 'alpha',
    ...ROSTER,
    ...over,
    store: undefined,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAccounts: async () => {},
    // What an agent's own page asks for beyond the list's needs. Stubbed to
    // nothing so a test can mount the page and override only what it is about.
    installsFor: async () => null,
    healthFor: async () => null,
    newSessionDefaultsFor: async () => ({}),
    optionsFor: async () => [],
    listModels: async () => [],
    ...(over.store ?? {}),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <RuntimesSection onSignIn={() => {}} />
      </StoreProvider>,
    )
  })
}

/** The name of every agent currently drawn, in order — read off its line. */
const listed = (): string[] =>
  [...document.body.querySelectorAll('[data-slot="agent-row"]')].map(
    (node) => node.querySelector('[data-role="subject"]')?.textContent ?? '',
  )

/** The agents under each group's head, by group. */
const grouped = (): Record<string, string[]> =>
  Object.fromEntries(
    [...document.body.querySelectorAll('[data-group]')].map((group) => [
      group.getAttribute('data-group'),
      [...group.querySelectorAll('[data-slot="agent-row"]')].map(
        (node) => node.querySelector('[data-role="subject"]')?.textContent ?? '',
      ),
    ]),
  )

/** An agent's line, by its name. */
const line = (name: string): HTMLButtonElement =>
  [...document.body.querySelectorAll('[data-slot="agent-row"]')].find(
    (node) => node.querySelector('[data-role="subject"]')?.textContent === name,
  ) as HTMLButtonElement

it("each agent's line says who it is signed in as, and at its end only what is not fine", async () => {
  await mountList()

  // The account is the line, across the agent's runtimes — not a count.
  expect(line('Alpha').textContent).toContain('ada@example.com and 1 more')
  expect(line('Beta').textContent).toContain('API key')
  expect(document.body.textContent).not.toMatch(/\b1 account\b/)
  // How the credential arrives is the agent's definition, not a state: it is
  // on its page and in Sign in, not on every line.
  expect(document.body.textContent).not.toContain('Browser sign-in')
  // Nothing is said where there is nothing to say: no "No account", no "Ready".
  expect(document.body.textContent).not.toContain('No account')
  const chips = [...document.body.querySelectorAll('[class*=chip]')].map((node) => node.textContent)
  expect(chips).toContain('Default')
  expect(chips).not.toContain('Ready')
  // A signed-out agent carries its Sign in, not a chip saying it needs one.
  expect(chips).not.toContain('Needs sign-in')
})

it('lists what needs you first, with its Sign in on its own line', async () => {
  const signInAgent = vi.fn(async () => {})
  await mountList({ store: { signInAgent } })

  // Alpha's second account is signed in too, so an unfinished sibling is not
  // allowed to report the whole agent as needing one.
  expect(grouped()).toEqual({ 'Needs attention': ['Gamma'], Ready: ['Alpha', 'Beta'] })

  // A real button beside the line, not inside it: the line opens the page.
  const signIn = line('Gamma').closest('[data-slot="row-folding"]')?.querySelector('[data-slot="row-action"] button')
  expect(signIn?.textContent).toContain('Sign in')
  expect(line('Gamma').contains(signIn ?? null)).toBe(false)
  await act(async () => (signIn as HTMLButtonElement).click())
  expect(signInAgent).toHaveBeenCalledWith('gamma')
})

it('gives an agent that has not answered yet its own heading, neither Needs attention nor Ready', async () => {
  // Gamma absent from accountsByRuntime altogether: still loading, or a read
  // that failed silently — it has not asked anyone for anything yet, unlike
  // a confirmed sign-out, so it does not belong beside a dead agent or a
  // spent plan window under "Needs attention". And "Ready" is a claim
  // `unknown` promises never to make, so it is not folded in there either.
  const accounts = { ...ROSTER.accountsByRuntime }
  delete (accounts as Record<string, unknown>).gamma
  await mountList({ accountsByRuntime: accounts })

  expect(grouped()).toEqual({ 'Not answered yet': ['Gamma'], Ready: ['Alpha', 'Beta'] })
  const chips = [...line('Gamma').querySelectorAll('[class*=chip]')].map((node) => node.textContent)
  expect(chips).toContain('Not answered yet')
  expect(chips).not.toContain('Needs sign-in')
  // No Sign in either: readiness has not said one is needed.
  expect(line('Gamma').closest('[data-slot="row-folding"]')?.querySelector('[data-slot="row-action"] button')).toBeFalsy()
})

it("a line opens its agent's page, where the accounts under it are", async () => {
  await mountList()
  expect(document.body.textContent).not.toContain('grace@example.com')

  await act(async () => line('Alpha').click())
  const accounts = [...document.body.querySelectorAll('[data-slot="section-name"]')].find(
    (node) => node.textContent === 'Accounts',
  )
  expect(accounts).toBeTruthy()
  expect(document.body.textContent).toContain('ada@example.com')
  expect(document.body.textContent).toContain('grace@example.com')
  // The account's plan and which way its figure counts: automatic uses the
  // shortest reported account-wide window, so 70% remains in the 5-hour lane
  // while the longer weekly lane has 27% remaining.
  expect(document.body.textContent).toContain('Pro')
  expect(document.body.textContent).toContain('70% left')
  expect(document.body.textContent).not.toMatch(/\b27% left/)
  // Its ways to add another stand in the section's head.
  expect(button('Add account')).toBeTruthy()

  await act(async () => button('Runtimes')?.click())
  expect(listed()).toEqual(['Gamma', 'Alpha', 'Beta'])
})

it('an agent that will not start shows its own words on its page, its lines kept, and the repair', async () => {
  const health = {
    state: 'unavailable',
    reason: 'unknown',
    message:
      'Delta refuses its own configuration:\nconfig is invalid: ~/.delta/x.json\n\u00d7 x.json:12 \u2014 Unrecognized key: "a"',
    remediation: '`delta doctor --fix` migrates the keys it knows.',
  }
  await mountList({
    runtimes: [
      ...ROSTER.runtimes,
      runtime({ id: 'delta', name: 'Delta', presentation: { name: 'Delta' } }),
    ],
    accountsByRuntime: { ...ROSTER.accountsByRuntime, delta: signedIn([], []) },
    healthByRuntime: { delta: health },
    store: { healthFor: async () => health },
  })

  // On the list it is named, not explained: the explanation is its page's.
  expect(grouped()['Needs attention']).toContain('Delta')
  expect([...line('Delta').querySelectorAll('[class*=chip]')].map((node) => node.textContent)).toContain('Unavailable')
  await act(async () => line('Delta').click())

  // The agent's own output keeps its line breaks; a validator writes one
  // finding per line and a paragraph of them is what nobody read.
  const block = document.body.querySelector('pre')
  // It scrolls inside a window of 170px, and the window is a flush card that
  // keeps its corners.
  const window = block?.closest('[data-slot="card-viewport"]') as HTMLElement | null
  expect(window?.getAttribute('data-size')).toBe('lines')
  expect(window?.style.maxHeight).toBe('170px')
  expect(window?.closest('[data-slot="card"]')?.getAttribute('data-variant')).toBe('flush')
  expect(block?.textContent).toContain('\u00d7 x.json:12')
  expect(block?.textContent).toContain('config is invalid: ~/.delta/x.json')
  // Our sentence introduces the block rather than being buried inside it,
  // and its lead-in colon does not dangle.
  expect(block?.textContent).not.toContain('refuses its own configuration')
  expect(document.body.textContent).toContain('Delta refuses its own configuration')
  expect(document.body.textContent).not.toContain('configuration:')
  // The repair is a command, set as one — not backticks printed on screen.
  expect(document.body.textContent).not.toContain('`delta doctor --fix`')
  expect([...document.body.querySelectorAll('code')].map((node) => node.textContent)).toContain(
    'delta doctor --fix',
  )
  // Said once: the accounts card does not tell a dead agent's story again, nor
  // call it one that needs a credential.
  expect(document.body.textContent).not.toContain('has no credential here yet')
})

it('search finds an agent by the address of an account under it', async () => {
  await mountList()
  type('input[aria-label="Search runtimes or accounts"]', 'grace@')
  expect(listed()).toEqual(['Alpha'])
})

it('a search that finds nothing offers the way back', async () => {
  await mountList()
  type('input[aria-label="Search runtimes or accounts"]', 'nobody')

  expect(listed()).toEqual([])
  expect(document.body.textContent).toContain('No runtime matches')

  await act(async () => button('Clear search')?.click())
  expect(listed()).toEqual(['Gamma', 'Alpha', 'Beta'])
})

it('a pin on a copy that has gone says so, and names the copy that runs (#219)', async () => {
  const chosen = {
    path: '/opt/homebrew/bin/opencode',
    version: '1.18.29',
    channel: 'homebrew' as const,
    channelLabel: 'Homebrew',
    standing: 'chosen' as const,
    managed: false,
    updateCommand: 'brew upgrade opencode',
  }
  // A pin is still recorded, on a copy that is no longer on the machine.
  const install = { copies: [chosen], chosen, policy: 'pinned' as const, fallback: null, checkedAt: 0 }
  const info = runtime({
    id: 'opencode',
    name: 'OpenCode',
    presentation: { name: 'OpenCode' },
    origin: 'registry',
    capabilities: { ...NO_CAPABILITIES },
    install,
  })
  await mountList({
    runtimes: [info],
    accountsByRuntime: { opencode: signedIn([], []) },
    store: { installsFor: vi.fn(async () => install), useInstall: vi.fn(async () => install), updateAgent: vi.fn(async () => true) },
  })
  const open = [...document.body.querySelectorAll('button')].find((node) => node.querySelector('[data-slot="text"][data-role="subject"]')) as HTMLButtonElement
  await act(async () => open.click())
  expect(document.body.textContent).toContain('Running 1.18.29 · via Homebrew')
  expect(document.body.textContent).not.toContain('Pinned to')
  expect(document.body.textContent).toContain('The pinned copy is gone or too old')
  // The pin is recorded, so it can still be cleared.
  expect(document.body.textContent).toContain('Use newest')
})

/** One agent's own page, opened on one install — the Install section it draws. */
const openInstall = async (install: InstallInfo): Promise<void> => {
  await mountList({
    runtimes: [
      runtime({
        id: 'opencode',
        name: 'OpenCode',
        presentation: { name: 'OpenCode' },
        origin: 'registry',
        capabilities: { ...NO_CAPABILITIES },
        install,
      }),
    ],
    accountsByRuntime: { opencode: signedIn([], []) },
    store: { installsFor: vi.fn(async () => install), useInstall: vi.fn(async () => install), updateAgent: vi.fn(async () => true) },
  })
  const head = [...document.body.querySelectorAll('button')].find((node) => node.querySelector('[data-slot="text"][data-role="subject"]')) as
    | HTMLButtonElement
    | undefined
  if (head) await act(async () => head.click())
}

it('a pin recorded with nothing new enough left says no installed copy answers (#251)', async () => {
  // A pin is recorded on a copy that has gone, and the rule that picks again
  // picks nothing: every copy left is too old or never answered for its
  // version, so the host chose none at all (`judgeInstalls`).
  const tooOld = {
    path: '/opt/homebrew/bin/opencode',
    version: '1.0.0',
    channel: 'homebrew' as const,
    channelLabel: 'Homebrew',
    standing: 'too-old' as const,
    managed: false,
    updateCommand: 'brew upgrade opencode',
  }
  const unreadable = {
    path: '/Users/x/.npm-global/bin/opencode',
    version: null,
    channel: 'npm-global' as const,
    channelLabel: 'npm',
    standing: 'unreadable' as const,
    managed: false,
    updateCommand: null,
  }
  await openInstall({ copies: [tooOld, unreadable], chosen: null, policy: 'pinned', fallback: null, minVersion: '1.18.0', checkedAt: 0 })

  // The title line says none of them qualifies, and says it either way.
  expect(document.body.textContent).toContain('No installed copy qualifies, and there is no fallback')
  // The line under it used to promise the copy the line above it had denied.
  expect(document.body.textContent).toContain('so no installed copy answers')
  expect(document.body.textContent).not.toContain('the newest copy that is new enough answers until you pin another')
  // The pin is recorded, so it can still be cleared.
  expect(document.body.textContent).toContain('Use newest')
})

it('a pin that holds still reads as one — the control for #251', async () => {
  const pinned = {
    path: '/opt/homebrew/bin/opencode',
    version: '1.18.29',
    channel: 'homebrew' as const,
    channelLabel: 'Homebrew',
    standing: 'pinned' as const,
    managed: false,
    updateCommand: 'brew upgrade opencode',
  }
  await openInstall({ copies: [pinned], chosen: pinned, policy: 'pinned', fallback: null, checkedAt: 0 })
  expect(document.body.textContent).toContain('Pinned to 1.18.29 · via Homebrew')
  expect(document.body.textContent).toContain('A pinned copy answers even when a newer one is installed.')
})

/*
 * The same contradiction on the other half of the rule (#251, round 2).
 *
 * With no pin recorded the policy is `newest` whatever the scan found
 * (`service.ts`), and `judgeInstalls` still chooses nothing when no copy on
 * the machine is usable — so `chosen` is null under `policy: 'newest'` too.
 * The description promised "the newest copy that is new enough answers" in
 * every one of those states, directly under a title line saying none does.
 */
const TOO_OLD = {
  path: '/opt/homebrew/bin/opencode',
  version: '1.0.0',
  channel: 'homebrew' as const,
  channelLabel: 'Homebrew',
  standing: 'too-old' as const,
  managed: false,
  updateCommand: 'brew upgrade opencode',
}
const UNREADABLE = {
  path: '/Users/x/.npm-global/bin/opencode',
  version: null,
  channel: 'npm-global' as const,
  channelLabel: 'npm',
  standing: 'unreadable' as const,
  managed: false,
  updateCommand: null,
}
/** The promise that must not be made when no installed copy answers. */
const NEWEST_ANSWERS = 'The newest copy that is new enough answers'

it('no pin and nothing new enough says so, with no fallback to run (#251)', async () => {
  await openInstall({ copies: [TOO_OLD, UNREADABLE], chosen: null, policy: 'newest', fallback: null, minVersion: '1.18.0', checkedAt: 0 })
  expect(document.body.textContent).toContain('No installed copy qualifies, and there is no fallback')
  expect(document.body.textContent).toContain('No copy installed is new enough')
  expect(document.body.textContent).not.toContain(NEWEST_ANSWERS)
})

it('no pin and nothing new enough says so while the fallback runs (#251)', async () => {
  await openInstall({
    copies: [TOO_OLD, UNREADABLE],
    chosen: null,
    policy: 'newest',
    fallback: { command: 'npx -y opencode-ai@latest', version: null, managed: false },
    minVersion: '1.18.0',
    checkedAt: 0,
  })
  expect(document.body.textContent).toContain('no installed copy qualifies')
  expect(document.body.textContent).toContain('No copy installed is new enough')
  expect(document.body.textContent).not.toContain(NEWEST_ANSWERS)
})

it('a machine with no copy at all is told that, not that the newest answers (#251)', async () => {
  await openInstall({ copies: [], chosen: null, policy: 'newest', fallback: null, minVersion: '1.18.0', checkedAt: 0 })
  expect(document.body.textContent).toContain('Not installed')
  expect(document.body.textContent).toContain('No copy is installed')
  expect(document.body.textContent).not.toContain(NEWEST_ANSWERS)
})

it('a copy that does qualify still reads as the newest answering — the control for #251', async () => {
  const chosen = {
    path: '/opt/homebrew/bin/opencode',
    version: '1.19.0',
    channel: 'homebrew' as const,
    channelLabel: 'Homebrew',
    standing: 'chosen' as const,
    managed: false,
    updateCommand: 'brew upgrade opencode',
  }
  await openInstall({ copies: [chosen, TOO_OLD], chosen, policy: 'newest', fallback: null, minVersion: '1.18.0', checkedAt: 0 })
  expect(document.body.textContent).toContain('Running 1.19.0 · via Homebrew')
  expect(document.body.textContent).toContain(
    'The newest copy that is new enough answers; a copy installed or updated later is picked up on the next check.',
  )
})

it("an agent's own page shows every copy on the machine, and offers the two verbs", async () => {
  const install = {
    copies: [
      {
        path: '/opt/homebrew/bin/opencode',
        version: '1.18.29',
        channel: 'homebrew' as const,
        channelLabel: 'Homebrew',
        standing: 'chosen' as const,
        managed: false,
        updateCommand: 'brew upgrade opencode',
      },
      {
        path: '/Users/x/.npm-global/bin/opencode',
        version: '1.18.20',
        channel: 'npm-global' as const,
        channelLabel: 'npm',
        standing: 'older' as const,
        managed: false,
        updateCommand: 'npm install -g opencode-ai@latest',
      },
    ],
    policy: 'newest' as const,
    fallback: { command: '/tmp/state/acp-agents/opencode/1.18.20/opencode', version: '1.18.20', managed: true },
    registryUpdate: { version: '1.18.30' },
    home: { path: '~/.local/share/opencode', env: 'XDG_DATA_HOME' },
    signIn: { terminal: 'opencode auth login', note: 'Providers are added one at a time.' },
    installCommand: 'brew install opencode',
    checkedAt: 0,
  }
  const info = runtime({
    id: 'opencode',
    name: 'OpenCode',
    presentation: { name: 'OpenCode' },
    origin: 'registry',
    capabilities: { ...NO_CAPABILITIES },
    install: { ...install, chosen: install.copies[0] },
  })
  const installsFor = vi.fn(async () => info.install)
  const useInstall = vi.fn(async () => info.install)
  const updateAgent = vi.fn(async () => true)
  await mountList({
    runtimes: [info],
    accountsByRuntime: { opencode: signedIn([], []) },
    store: { installsFor, useInstall, updateAgent },
  })

  // The agent's line opens its own page.
  await act(async () => line('OpenCode').click())

  expect(installsFor).toHaveBeenCalledWith('opencode')
  // Every copy, its road, and why each stands where it does.
  expect(document.body.textContent).toContain('Running 1.18.29 · via Homebrew (1 other copy found)')
  expect(document.body.textContent).toContain('/opt/homebrew/bin/opencode')
  expect(document.body.textContent).toContain('1.18.20 · via npm')
  // An outranked copy says what to do about it; the one in use says where it
  // is, which is the fact you check against your own terminal.
  expect(document.body.textContent).toContain('npm install -g opencode-ai@latest')
  expect([...document.body.querySelectorAll('[class*=chip]')].map((node) => node.textContent)).toEqual(
    expect.arrayContaining(['In use', 'Older']),
  )
  // The desk updates what it downloaded, and names the command for the rest.
  // The desk updates the build it downloaded, from the fallback's own row.
  expect(document.body.textContent).toContain('Update to 1.18.30')
  // Where it keeps its own world, and how it is signed into.
  expect(document.body.textContent).toContain('~/.local/share/opencode')
  expect(document.body.textContent).toContain('opencode auth login')

  // Every copy that could answer offers the pin: the one in use, to freeze
  // today's winner, and the one outranked, to override the rule.
  const pins = [...document.body.querySelectorAll('button')].filter((node) => node.textContent === 'Pin')
  expect(pins).toHaveLength(2)
  await act(async () => (pins[1] as HTMLButtonElement).click())
  expect(useInstall).toHaveBeenCalledWith('opencode', '/Users/x/.npm-global/bin/opencode')

  const update = [...document.body.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('Update to'),
  )
  await act(async () => (update as HTMLButtonElement).click())
  expect(updateAgent).toHaveBeenCalledWith('opencode')
})

it('a search hit on a second account leads its agent\u2019s line', async () => {
  await mountList()
  type('input[aria-label="Search runtimes or accounts"]', 'grace@')
  expect(line('Alpha').textContent).toContain('grace@example.com and 1 more')
})

it('a key-only agent hands its Sign in to the page that has a field, and a pending one waits', async () => {
  const onSignIn = vi.fn()
  const signInAgent = vi.fn(async () => {})
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: 'gamma',
    ...ROSTER,
    accountsByRuntime: { ...ROSTER.accountsByRuntime, beta: signedIn([], ['apiKey']) },
    logins: { gamma: { method: 'm0', start: { type: 'browser', loginId: 'l1' }, outcome: { type: 'pending' } } },
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAccounts: async () => {},
    signInAgent,
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <RuntimesSection onSignIn={onSignIn} />
      </StoreProvider>,
    )
  })
  const action = (name: string) =>
    line(name).closest('[data-slot="row-folding"]')?.querySelector('[data-slot="row-action"] button') as HTMLButtonElement
  await act(async () => action('Beta').click())
  expect(onSignIn).toHaveBeenCalledWith('beta')
  expect(signInAgent).not.toHaveBeenCalled()
  // Gamma is the default and signed out: its Default chip and its Sign in,
  // never a third chip saying what the button says.
  const chips = new Set([...line('Gamma').querySelectorAll('[class*=chip]')].map((node) => node.textContent))
  expect([...chips]).toEqual(['Default'])
  expect(action('Gamma').textContent).toContain('Waiting')
  expect(action('Gamma').disabled).toBe(true)
})

it('back from an account lands on its agent, and a second account\u2019s page lists the agent\u2019s own accounts', async () => {
  await mountList({ store: { limitsFor: async () => null, setAccountPrefs: () => {} } })
  await act(async () => line('Alpha').click())
  const account = [...document.body.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('grace@example.com'),
  ) as HTMLButtonElement
  await act(async () => account.click())
  await act(async () => button('Alpha')?.click())
  // Its agent's page, not the list: the accounts section is there.
  expect(
    [...document.body.querySelectorAll('[data-slot="section-name"]')].some((node) => node.textContent === 'Accounts'),
  ).toBe(true)
  expect(listed()).toEqual([])
})

it('opened on a second account\u2019s runtime, the page answers for the agent', async () => {
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: 'alpha',
    ...ROSTER,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadAccounts: async () => {},
    installsFor: async () => null,
    healthFor: async () => null,
    newSessionDefaultsFor: async () => ({}),
    optionsFor: async () => [],
    listModels: async () => [],
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <RuntimesSection onSignIn={() => {}} focus="alpha#2" />
      </StoreProvider>,
    )
  })
  // Both accounts, the agent's own one marked Default, and no "never
  // finished" slot invented out of the agent's own runtime.
  expect(document.body.textContent).toContain('ada@example.com')
  expect(document.body.textContent).toContain('grace@example.com')
  expect(document.body.textContent).not.toContain('Waiting to be signed in')
  const ada = [...document.body.querySelectorAll('button')].find((node) => node.textContent?.includes('ada'))
  expect(ada?.textContent).toContain('Default')
})
