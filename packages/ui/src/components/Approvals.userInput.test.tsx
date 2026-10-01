import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sessionKey, type Approval, type ApprovalOption, type RuntimeId, type RuntimeInfo } from '@harnessdesk/protocol'

import { PaneProvider, StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { BOARD_TOOL_FRAME_OPTIONS } from '../preview/approval-fixture'
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
  presentation: { name: 'Gemini CLI', boardToolApproval: { permanentApprovalSetting: 'security.enablePermanentToolApproval', sessionOptionLabel: 'Allow for this session', onceOptionLabel: 'Allow once' } },
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

// The choices Gemini 0.62 really sends for an MCP tool (one fixture, shared with the preview and the catalogue).
const SESSION_SET = BOARD_TOOL_FRAME_OPTIONS.session as unknown as readonly ApprovalOption[]
const PERMANENT_SET = BOARD_TOOL_FRAME_OPTIONS.permanent as unknown as readonly ApprovalOption[]
const NO_GRANT_SET = BOARD_TOOL_FRAME_OPTIONS.none as unknown as readonly ApprovalOption[]
const BOARD_TITLE = 'list_intents (harnessdesk MCP Server)'
const GUIDANCE = "To always allow, turn on permanent tool approval in Gemini CLI's settings."

const buttonsOf = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
const labelsOf = () => buttonsOf().map((button) => button.textContent?.trim().replace(/\d+$/, ''))
const noteOf = () => Array.from(container.querySelectorAll('[data-slot="approval-reason"]')).at(-1)

it("says what the board wants to do in plain words, with Allow once primary and every grant quiet", () => {
  mount(boardApproval(BOARD_TITLE, SESSION_SET), geminiInfo)

  expect(container.textContent).toContain("HarnessDesk's board wants to list the board's work items. HarnessDesk can't confirm which server is asking.")
  expect(container.textContent).not.toContain('list_intents')
  expect(container.textContent).not.toContain('you can choose')
  // The agent's own order decides the shortcut numbers; the card draws refusal first and the plain yes last.
  expect(labelsOf()).toEqual(['Reject', 'Allow all server tools for this session', 'Allow for this session', 'Allow once'])
  expect(buttonsOf().map((button) => button.getAttribute('data-variant'))).toEqual(['secondary', 'secondary', 'secondary', 'default'])
  const tool = buttonsOf().find((button) => button.textContent?.includes('Allow for this session'))
  expect(tool?.title).toBe('Allows this tool for the rest of this session.')
  expect(buttonsOf().filter((button) => button === document.activeElement)).toHaveLength(0)
})

it('keeps a server-wide grant under its own explicit label, so it never reads like the one-tool grant', () => {
  mount(boardApproval(BOARD_TITLE, SESSION_SET), geminiInfo)
  const labels = labelsOf()
  expect(labels).toContain('Allow all server tools for this session')
  expect(labels.filter((label) => label === 'Allow for this session')).toHaveLength(1)
  expect(buttonsOf().find((button) => button.textContent?.includes('Allow all server tools'))?.title).toBe('Allows every tool from this server for this session.')
})

it('says how to turn on a lasting grant when every grant on offer ends with the session, with the key only in a title', () => {
  mount(boardApproval(BOARD_TITLE, SESSION_SET), geminiInfo)
  expect(noteOf()?.textContent).toContain(GUIDANCE)
  expect(noteOf()?.getAttribute('title')).toBe('security.enablePermanentToolApproval')
  expect(container.textContent).not.toContain('security.enablePermanentToolApproval')
})

it('does not say that when the agent offers a grant that outlives the session, and keeps that grant quiet and labelled as the agent has it', () => {
  mount(boardApproval(BOARD_TITLE, PERMANENT_SET), geminiInfo)
  expect(container.textContent).not.toContain('To always allow')
  expect(labelsOf()).toEqual(['Reject', 'Allow all server tools for this session', 'Allow for this session', 'Allow tool for all future sessions', 'Allow once'])
  expect(buttonsOf().map((button) => button.getAttribute('data-variant'))).toEqual(['secondary', 'secondary', 'secondary', 'secondary', 'default'])
  expect(buttonsOf().find((button) => button.textContent?.includes('future sessions'))?.title).toBe('Saves approval for this tool in future sessions.')
})

it('with no grant on offer, shows only Allow once and Reject and says how to turn one on', () => {
  mount(boardApproval(BOARD_TITLE, NO_GRANT_SET), geminiInfo)
  expect(labelsOf()).toEqual(['Reject', 'Allow once'])
  expect(noteOf()?.textContent).toContain(GUIDANCE)
})

it('never relabels when the agent offers two tool-scoped session grants: the names would collide', () => {
  const twin = { ...SESSION_SET[1]!, id: 'proceed_always_tool_2' }
  mount(boardApproval(BOARD_TITLE, [SESSION_SET[1]!, twin, SESSION_SET[2]!, SESSION_SET[3]!]), geminiInfo)
  expect(labelsOf().filter((label) => label === 'Allow for this session')).toHaveLength(0)
  expect(labelsOf().filter((label) => label === 'Allow tool for this session')).toHaveLength(2)
})

it('leaves a runtime that does not ask per tool exactly as the agent worded it', () => {
  mount(boardApproval(BOARD_TITLE, SESSION_SET), info)
  expect(container.textContent).not.toContain("HarnessDesk's board wants to")
  expect(labelsOf()).toContain('Allow')
  expect(labelsOf()).not.toContain('Allow once')
})

it.each([
  'edit_file (harnessdesk MCP Server)',
  'list_intents (other MCP Server)',
  'list_intents (harnessdesk mcp server)',
])('does not explain a title that is not an exact desk board tool title: %s', (summary) => {
  mount(boardApproval(summary, SESSION_SET), geminiInfo)
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
