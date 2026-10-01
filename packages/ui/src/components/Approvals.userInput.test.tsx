import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionKey, type Approval, type ApprovalOption, type RuntimeId, type RuntimeInfo } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { Approvals } from './Approvals'

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

const RUNTIME = 'agent-a' as unknown as RuntimeId
const SESSION = 'session-1'
const KEY = sessionKey(RUNTIME, SESSION)

const info = {
  id: RUNTIME,
  name: 'Agent A',
  capabilities: {},
  presentation: { name: 'Agent A' },
} as unknown as RuntimeInfo

const PANE = 'pane-1' as never

const mount = (approval: Approval, runtimeInfo: RuntimeInfo = info) => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    contributions: [boardToolContribution],
    activeRuntime: RUNTIME,
    runtimes: [runtimeInfo],
    approvals: [{ key: KEY, approval }],
    layout: { ...emptySnapshot().layout, focused: PANE },
    workbench: { ...emptySnapshot().workbench, main: { ...emptySnapshot().workbench.main, focused: PANE }, focus: null },
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    respondToApproval: vi.fn(async () => undefined),
  } as unknown as AppStore & { respondToApproval: ReturnType<typeof vi.fn> }
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <PaneProvider
          scope={{ paneId: PANE, view: { kind: 'conversation', session: KEY }, sessionKey: KEY }}
        >
          <Approvals />
        </PaneProvider>
      </StoreProvider>,
    )
  })
  return store
}

const geminiInfo = {
  ...info,
  capabilities: { perToolMcpApproval: true },
  presentation: { name: 'Gemini CLI', boardToolApproval: { permanentApprovalSetting: 'security.enablePermanentToolApproval', sessionOptionLabel: 'Allow for this session' } },
} as unknown as RuntimeInfo

const boardToolContribution = {
  kind: 'tool', namespace: 'harnessdesk', name: 'list_intents',
  description: 'The shared board for this workspace: every intent (piece of work), its state — open, claimed, blocked, done — who holds it, the files it owns, and what depends on what.',
  id: 'team/list_intents', owner: 'team', revision: 1, scope: 'session', inputSchema: {},
} as unknown as AppSnapshot['contributions'][number]

const boardApproval = (summary: string, options: readonly ApprovalOption[]): Approval => ({
  id: 'approval-board-tool' as never,
  sessionId: SESSION as never,
  requestedAt: Date.now(),
  type: 'permission',
  summary,
  options,
})

const BOARD_OPTIONS: readonly ApprovalOption[] = [
  { id: 'always', label: 'Allow tool for this session', description: 'Allows this tool for the rest of this session.', intent: 'approveAlways' },
  { id: 'deny', label: 'Deny', intent: 'deny' },
  { id: 'once', label: 'Allow once', intent: 'approve' },
]

it('explains the board action without naming the wire tool and keeps session approval quiet', () => {
  mount(boardApproval('list_intents (harnessdesk MCP Server)', BOARD_OPTIONS), geminiInfo)

  expect(container.textContent).toContain("HarnessDesk's board wants to list the board's work items. HarnessDesk can't confirm which server is asking.")
  expect(container.textContent).not.toContain('list_intents')
  expect(container.textContent).toContain("HarnessDesk can't confirm which server is asking.")
  expect(container.textContent).not.toContain('list_intents')
  expect(container.textContent).not.toContain('you can choose')
  expect(container.textContent).not.toContain('Allows this tool for the rest of this session.')
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
  expect(buttons.map((button) => button.textContent?.trim().replace(/\d+$/, ''))).toEqual(['Deny', 'Allow for this session', 'Allow once'])
  expect(buttons.find((button) => button.textContent?.includes('Allow for this session'))?.getAttribute('data-variant')).toBe('secondary')
  expect(buttons.find((button) => button.textContent?.includes('Allow once'))?.getAttribute('data-variant')).toBe('default')
  expect(buttons.find((button) => button.textContent?.includes('Allow for this session'))?.title).toBe('Allows this tool for the rest of this session.')
  expect(buttons.find((button) => button.textContent?.includes('Allow for this session'))).not.toBe(document.activeElement)
})

it('explains when Gemini offers no permanent option without exposing its setting key', () => {
  mount(boardApproval('list_intents (harnessdesk MCP Server)', [
    { id: 'deny', label: 'Deny', intent: 'deny' },
    { id: 'once', label: 'Allow once', intent: 'approve' },
  ]), geminiInfo)

  expect(container.textContent).toContain("HarnessDesk can't confirm which server is asking.")
  const note = container.querySelector('[data-slot="approval-reason"]')
  expect(note?.textContent).toContain("To always allow, turn on permanent tool approval in Gemini CLI's settings.")
  expect(note?.getAttribute('title')).toBe('security.enablePermanentToolApproval')
  expect(container.textContent).not.toContain('security.enablePermanentToolApproval')
})

it('describes each Gemini allow-always scope in its offered order and leaves Allow once primary', () => {
  mount(boardApproval('list_intents (harnessdesk MCP Server)', [
    { id: 'server', label: 'Allow all server tools for this session', description: 'Allows every tool from this server for this session.', intent: 'approveAlways' },
    { id: 'tool', label: 'Allow tool for this session', description: 'Allows this tool for the rest of this session.', intent: 'approveAlways' },
    { id: 'future', label: 'Allow tool for all future sessions', description: 'Saves approval for this tool in future sessions.', intent: 'approveAlways' },
    { id: 'once', label: 'Allow once', intent: 'approve' },
    { id: 'deny', label: 'Deny', intent: 'deny' },
  ]), geminiInfo)

  const note = Array.from(container.querySelectorAll('[data-slot="approval-reason"]')).at(-1)?.textContent ?? ''
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
  expect(buttons.map((button) => button.getAttribute('data-variant'))).toEqual(['destructive', 'secondary', 'secondary', 'secondary', 'default'])
  // Two session grants, one of them server-wide: the agent's own labels stay, so a broader grant never reads as a narrow one.
  expect(buttons[1]?.textContent).toContain('Allow all server tools for this session')
  expect(buttons[2]?.textContent).toContain('Allow tool for this session')
  expect(buttons[2]?.textContent).not.toContain('Allow for this session')
  expect(note).not.toContain('To always allow')
  expect(buttons[3]?.textContent).toContain('Allow tool for all future sessions')
  expect(buttons[3]?.title).toBe('Saves approval for this tool in future sessions.')
  expect(buttons.at(-1)?.textContent).toContain('Allow once')
  expect(buttons.slice(1, 4)).not.toContain(document.activeElement)
})

it.each([
  'edit_file (harnessdesk MCP Server)',
  'list_intents (other MCP Server)',
  'list_intents (harnessdesk mcp server)',
])('does not explain a title that is not an exact desk board tool title: %s', (summary) => {
  mount(boardApproval(summary, BOARD_OPTIONS), geminiInfo)
  expect(container.textContent).not.toContain("HarnessDesk's board wants to")
})

it('allows selecting multiple options and toggling selections when multiSelect is true (#380)', () => {
  const approval: Approval = {
    id: 'user-input-1',
    sessionId: SESSION,
    requestedAt: Date.now(),
    type: 'userInput',
    tool: 'ask_user',
    questions: [
      {
        id: 'q1',
        question: 'Which packages to install?',
        multiSelect: true,
        options: [
          { id: 'pkg1', label: 'Package 1' },
          { id: 'pkg2', label: 'Package 2' },
        ],
      },
    ],
  } as unknown as Approval

  const store = mount(approval)

  const buttons = container.querySelectorAll<HTMLButtonElement>('button')
  const opt1 = Array.from(buttons).find((b) => b.textContent?.includes('Package 1'))
  const opt2 = Array.from(buttons).find((b) => b.textContent?.includes('Package 2'))
  const submit = Array.from(buttons).find((b) => b.textContent?.includes('Send'))

  expect(opt1).toBeDefined()
  expect(opt2).toBeDefined()
  expect(submit).toBeDefined()

  // Select pkg1
  act(() => {
    opt1!.click()
  })
  expect(opt1!.hasAttribute('data-selected')).toBe(true)
  expect(opt2!.hasAttribute('data-selected')).toBe(false)

  // Select pkg2 (both should be selected now)
  act(() => {
    opt2!.click()
  })
  expect(opt1!.hasAttribute('data-selected')).toBe(true)
  expect(opt2!.hasAttribute('data-selected')).toBe(true)

  // Click pkg1 again to deselect it
  act(() => {
    opt1!.click()
  })
  expect(opt1!.hasAttribute('data-selected')).toBe(false)
  expect(opt2!.hasAttribute('data-selected')).toBe(true)

  // Submit and verify answers
  act(() => {
    submit!.click()
  })
  expect(store.respondToApproval).toHaveBeenCalledWith(KEY, 'user-input-1', {
    type: 'answers',
    answers: { q1: ['pkg2'] },
  })
})

it('selects only one option at a time when multiSelect is false', () => {
  const approval: Approval = {
    id: 'user-input-2',
    sessionId: SESSION,
    requestedAt: Date.now(),
    type: 'userInput',
    tool: 'ask_user',
    questions: [
      {
        id: 'q1',
        question: 'Which environment?',
        multiSelect: false,
        options: [
          { id: 'dev', label: 'Development' },
          { id: 'prod', label: 'Production' },
        ],
      },
    ],
  } as unknown as Approval

  const store = mount(approval)

  const buttons = container.querySelectorAll<HTMLButtonElement>('button')
  const dev = Array.from(buttons).find((b) => b.textContent?.includes('Development'))
  const prod = Array.from(buttons).find((b) => b.textContent?.includes('Production'))
  const submit = Array.from(buttons).find((b) => b.textContent?.includes('Send'))

  // Select dev
  act(() => {
    dev!.click()
  })
  expect(dev!.hasAttribute('data-selected')).toBe(true)
  expect(prod!.hasAttribute('data-selected')).toBe(false)

  // Select prod
  act(() => {
    prod!.click()
  })
  expect(dev!.hasAttribute('data-selected')).toBe(false)
  expect(prod!.hasAttribute('data-selected')).toBe(true)

  // Submit and verify answers
  act(() => {
    submit!.click()
  })
  expect(store.respondToApproval).toHaveBeenCalledWith(KEY, 'user-input-2', {
    type: 'answers',
    answers: { q1: ['prod'] },
  })
})

it('says how to turn on permanent approval when every grant on offer ends with the session', () => {
  mount(boardApproval('list_intents (harnessdesk MCP Server)', BOARD_OPTIONS), geminiInfo)
  expect(container.textContent).toContain("To always allow, turn on permanent tool approval in Gemini CLI's settings.")
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
  expect(buttons.some((button) => button.textContent?.includes('Allow for this session'))).toBe(true)
})

it('does not say that when the agent offers a grant that outlives the session', () => {
  mount(boardApproval('list_intents (harnessdesk MCP Server)', [
    { id: 'tool', label: 'Allow tool for this session', description: 'Allows this tool for the rest of this session.', intent: 'approveAlways' },
    { id: 'future', label: 'Allow tool for all future sessions', description: 'Saves approval for this tool in future sessions.', intent: 'approveAlways' },
    { id: 'once', label: 'Allow once', intent: 'approve' },
    { id: 'deny', label: 'Deny', intent: 'deny' },
  ]), geminiInfo)
  expect(container.textContent).not.toContain('To always allow')
  expect(container.textContent).toContain('Allow tool for all future sessions')
})
