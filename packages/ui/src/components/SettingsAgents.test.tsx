import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type {
  Account,
  AccountStatus,
  AcpRegistryAgentInfo,
  AgentTemplateInfo,
  RuntimeInfo,
} from '@harnessdesk/protocol'
import { NO_CAPABILITIES } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { AddAgents, AgentsSection } from './SettingsAgents'

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
  [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(label))

/** A form field, by the visible label `Field` points at it — the name a person reads. */
const byLabel = (text: string): string => {
  const label = [...container.querySelectorAll('label')].find((node) => node.textContent?.trim() === text)
  if (!label) throw new Error(`no label ${text}`)
  return `[id="${label.htmlFor}"]`
}

const type = (selector: string, value: string): void => {
  const field = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement | null
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
  expect(container.textContent).toContain('Agent One')
  expect(container.textContent).toContain('The one that works.')

  // Unavailable: the reason and the way out, not a bare grey button.
  expect(container.textContent).toContain('two is not installed on this machine.')
  expect(container.textContent).toContain('npm install -g two')

  // Registered: said, not re-offered.
  expect(container.textContent).toContain('Added')
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
  const buttons = [...container.querySelectorAll('button')].filter(
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
    button('Add agent')?.click()
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
  expect(container.querySelector('[role="dialog"][aria-label="Add a custom agent"]')).toBeNull()
  await act(async () => {
    button('Set up…')?.click()
  })
  const name = container.querySelector(byLabel('Name')) as HTMLInputElement
  const command = container.querySelector(byLabel('Command')) as HTMLInputElement
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
    button('Add agent')?.click()
  })
  const dialog = container.querySelector('[role="dialog"][aria-label="Add a custom agent"]')
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
    button('Add agent')?.click()
  })
  const alert = container.querySelector('[role="dialog"] [role="alert"]')
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

  expect(container.textContent).toContain('From the ACP registry')
  // Addable: the registry's own words under the name.
  expect(container.textContent).toContain('A local, extensible agent.')
  // Blocked: the reason where the description would be.
  expect(container.textContent).toContain('Needs uvx (uv), which is not on PATH.')
  // Registered: two Added chips now — the template's and Gemini's.
  expect(container.textContent).toContain('Gemini CLI')
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
  expect(container.textContent).toContain('goose')
  expect(container.textContent).not.toContain('fast-agent')
  expect(container.textContent).not.toContain('Filler 3')
})

/**
 * The list itself: ten agents on one page, read as a management roster.
 *
 * What the page owes someone with that many is a way to see all of them at
 * once and a way to find one of them — so each agent summarises its accounts
 * in its own one-line header and arrives folded unless it needs attention,
 * the caret and Expand all / Collapse all open the rest, and the two filters
 * agree with what the headers say.
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
        <AgentsSection onSignIn={() => {}} />
      </StoreProvider>,
    )
  })
}

/** The name of every agent currently drawn, in order — read off its caret. */
const listed = (): string[] =>
  [...container.querySelectorAll('button[aria-expanded]')].map(
    (node) => node.getAttribute('aria-label')?.replace(/^(Show|Hide) the accounts under /, '') ?? '',
  )

it("each agent's header summarises the accounts under it, and stays quiet when it can", async () => {
  await mountList()

  // Counted across the agent's runtimes, not just its first one.
  expect(container.textContent).toContain('2 accounts')
  expect(container.textContent).toContain('1 account')
  // How the credential arrives, read from the flows the runtime declares.
  expect(container.textContent).toContain('Browser sign-in')
  expect(container.textContent).toContain('API key')

  // The header answers with a count and a state, and nothing where it has
  // neither: a page of ten agents each saying "No account needed" is one
  // sentence of information and ten rows of height. See docs/design.md.
  expect(container.textContent).not.toContain('No account')
  // The state is named, never left as a coloured dot to decode — and only
  // where it is not the state everything is meant to be in.
  const chips = [...container.querySelectorAll('[class*=chip]')].map((node) => node.textContent)
  expect(chips).toContain('Needs sign-in')
  expect(chips).toContain('Default')
  expect(chips).not.toContain('Ready')
})

it('an agent that will not start shows its own words, its lines kept, and the repair', async () => {
  await mountList({
    runtimes: [
      ...ROSTER.runtimes,
      runtime({ id: 'delta', name: 'Delta', presentation: { name: 'Delta' } }),
    ],
    accountsByRuntime: { ...ROSTER.accountsByRuntime, delta: signedIn([], []) },
    healthByRuntime: {
      delta: {
        state: 'unavailable',
        reason: 'unknown',
        message:
          'Delta refuses its own configuration:\nconfig is invalid: ~/.delta/x.json\n\u00d7 x.json:12 \u2014 Unrecognized key: "a"',
        remediation: '`delta doctor --fix` migrates the keys it knows.',
      },
    },
  })

  // The agent's own output keeps its line breaks; a validator writes one
  // finding per line and a paragraph of them is what nobody read.
  const block = container.querySelector('pre')
  expect(block?.textContent).toContain('\u00d7 x.json:12')
  expect(block?.textContent).toContain('config is invalid: ~/.delta/x.json')
  // Our sentence introduces the block rather than being buried inside it,
  // and its lead-in colon does not dangle.
  expect(block?.textContent).not.toContain('refuses its own configuration')
  expect(container.textContent).toContain('Delta refuses its own configuration')
  expect(container.textContent).not.toContain('configuration:')
  // The repair is a command, set as one — not backticks printed on screen.
  expect(container.textContent).not.toContain('`delta doctor --fix`')
  expect([...container.querySelectorAll('code')].map((node) => node.textContent)).toContain(
    'delta doctor --fix',
  )
})

it('a healthy agent arrives folded; one that needs attention arrives open', async () => {
  await mountList()

  // Alpha is signed in and healthy, so its account rows wait behind the caret.
  expect(container.textContent).not.toContain('ada@example.com')
  // Gamma is waiting on a sign-in — that story is why anyone is here, so it
  // is already open and saying so.
  expect(container.textContent).toContain('has no credential here yet')
})

it('the caret opens an agent and folds it again, leaving the rest alone', async () => {
  await mountList()

  const caret = [...container.querySelectorAll('button[aria-expanded]')][0] as HTMLButtonElement
  await act(async () => caret.click())
  expect(container.textContent).toContain('ada@example.com')

  await act(async () => caret.click())
  expect(container.textContent).not.toContain('ada@example.com')
  // Folded, not filtered: the agent is still on the page, and so is everyone else.
  expect(listed()).toEqual(['Alpha', 'Beta', 'Gamma'])
  expect(container.textContent).toContain('2 accounts')
})

it('Expand all opens every block, and Collapse all folds the roster flat', async () => {
  await mountList()

  await act(async () => button('Expand all')?.click())
  expect(container.textContent).toContain('ada@example.com')

  // With everything open, the same control offers the way back.
  expect(button('Expand all')).toBeUndefined()
  await act(async () => button('Collapse all')?.click())
  expect(container.textContent).not.toContain('ada@example.com')
  // Collapse all is a say-so: it folds even the agent that opened itself.
  expect(container.textContent).not.toContain('has no credential here yet')
  expect(listed()).toEqual(['Alpha', 'Beta', 'Gamma'])
})

it('search finds an agent by the address of an account under it', async () => {
  await mountList()
  type('input[aria-label="Search agents or accounts"]', 'grace@')

  expect(listed()).toEqual(['Alpha'])
  // A hit is shown open — hiding what was searched for would be the wrong answer.
  expect(container.textContent).toContain('grace@example.com')
})

it('a search that finds nothing offers the way back', async () => {
  await mountList()
  type('input[aria-label="Search agents or accounts"]', 'nobody')

  expect(listed()).toEqual([])
  expect(container.textContent).toContain('No agent matches')

  await act(async () => button('Clear filters')?.click())
  expect(listed()).toEqual(['Alpha', 'Beta', 'Gamma'])
})

it('the status filter answers with the agents in that state', async () => {
  await mountList()
  const select = container.querySelector('select[aria-label="Filter by status"]') as HTMLSelectElement

  const pick = async (value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
      setter?.call(select, value)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  await pick('signin')
  expect(listed()).toEqual(['Gamma'])

  // Alpha's second account is signed in too, so an unfinished sibling is not
  // allowed to report the whole agent as needing one.
  await pick('ready')
  expect(listed()).toEqual(['Alpha', 'Beta'])
})

it('an account row says its plan and which way its figure counts', async () => {
  await mountList()
  // The row lives inside Alpha's block, which arrives folded.
  const caret = [...container.querySelectorAll('button[aria-expanded]')][0] as HTMLButtonElement
  await act(async () => caret.click())

  expect(container.textContent).toContain('Pro')
  // The tightest lane decides, and the number says what it means: 73% of the
  // weekly lane spent is 27% left, not 70% from the 5-hour one.
  expect(container.textContent).toContain('27% left')
  expect(container.textContent).not.toMatch(/\b73%/)
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

  // The agent's name opens its own page; the caret only folds its accounts.
  const open = [...container.querySelectorAll('button')].find((node) =>
    node.className.includes('headOpen'),
  ) as HTMLButtonElement
  await act(async () => open.click())

  expect(installsFor).toHaveBeenCalledWith('opencode')
  // Every copy, its road, and why each stands where it does.
  expect(container.textContent).toContain('Running 1.18.29 · via Homebrew (1 other copy found)')
  expect(container.textContent).toContain('/opt/homebrew/bin/opencode')
  expect(container.textContent).toContain('1.18.20 · via npm')
  // An outranked copy says what to do about it; the one in use says where it
  // is, which is the fact you check against your own terminal.
  expect(container.textContent).toContain('npm install -g opencode-ai@latest')
  expect([...container.querySelectorAll('[class*=chip]')].map((node) => node.textContent)).toEqual(
    expect.arrayContaining(['In use', 'Older']),
  )
  // The desk updates what it downloaded, and names the command for the rest.
  // The desk updates the build it downloaded, from the fallback's own row.
  expect(container.textContent).toContain('Update to 1.18.30')
  // Where it keeps its own world, and how it is signed into.
  expect(container.textContent).toContain('~/.local/share/opencode')
  expect(container.textContent).toContain('opencode auth login')

  // Every copy that could answer offers the pin: the one in use, to freeze
  // today's winner, and the one outranked, to override the rule.
  const pins = [...container.querySelectorAll('button')].filter((node) => node.textContent === 'Pin')
  expect(pins).toHaveLength(2)
  await act(async () => (pins[1] as HTMLButtonElement).click())
  expect(useInstall).toHaveBeenCalledWith('opencode', '/Users/x/.npm-global/bin/opencode')

  const update = [...container.querySelectorAll('button')].find((node) =>
    node.textContent?.includes('Update to'),
  )
  await act(async () => (update as HTMLButtonElement).click())
  expect(updateAgent).toHaveBeenCalledWith('opencode')
})
