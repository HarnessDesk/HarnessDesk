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

const mount = (approval: Approval, runtimeInfo: RuntimeInfo = info, context: Partial<AppSnapshot> = {}) => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    ...context,
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

const boardApproval = (summary: string, options: readonly ApprovalOption[]): Extract<Approval, { type: 'permission' }> => ({
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

it("says what the agent wants to do with the board in plain words, with Allow once primary and every grant quiet", () => {
  mount(boardApproval(BOARD_TITLE, SESSION_SET), geminiInfo)

  expect(container.textContent).toContain("Gemini CLI wants to use HarnessDesk's board to list the board's work items. HarnessDesk can't confirm which server is asking.")
  expect(container.textContent).not.toContain('list_intents')
  expect(container.textContent).not.toContain('you can choose')
  // The agent's own order decides the shortcut numbers; the card draws refusal first and the plain yes last.
  expect(labelsOf()).toEqual(['Reject', 'Allow all server tools for this session', 'Allow for this session', 'Allow once'])
  expect(buttonsOf().map((button) => button.getAttribute('data-variant'))).toEqual(['secondary', 'secondary', 'secondary', 'default'])
  const tool = buttonsOf().find((button) => button.textContent?.includes('Allow for this session'))
  expect(tool?.title).toBe('Allows this tool for the rest of this session.')
  expect(buttonsOf().filter((button) => button === document.activeElement)).toHaveLength(0)
})

it('gives only the plain Allow action primary weight and separates its shortcuts as keycaps', () => {
  const request = {
    id: 'command-approval',
    sessionId: SESSION,
    requestedAt: Date.now(),
    type: 'command',
    command: 'ls -la',
    cwd: '/work/storefront',
    options: [
      { id: 'allow', label: 'Allow', intent: 'approve' },
      { id: 'session', label: 'Allow for this session', intent: 'approveAlways' },
      { id: 'deny', label: 'Deny', intent: 'deny' },
    ],
  } as unknown as Approval
  mount(request)

  expect(labelsOf()).toEqual(['Deny', 'Allow for this session', 'Allow'])
  expect(buttonsOf().map((button) => button.getAttribute('data-variant'))).toEqual([
    'destructive', 'quiet', 'default',
  ])
  expect(buttonsOf().map((button) => button.querySelector('[data-slot="keycap"]')?.textContent)).toEqual([
    '3', '2', '1',
  ])
  expect(buttonsOf().every((button) => button.querySelector('[data-slot="keycap"]')?.getAttribute('aria-hidden') === 'true')).toBe(true)
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
  expect(container.textContent).not.toContain('wants to use HarnessDesk')
  expect(labelsOf()).toContain('Allow')
  expect(labelsOf()).not.toContain('Allow once')
})

it.each([
  'edit_file (harnessdesk MCP Server)',
  'list_intents (other MCP Server)',
  'list_intents (harnessdesk mcp server)',
])('does not explain a title that is not an exact desk board tool title: %s', (summary) => {
  mount(boardApproval(summary, SESSION_SET), geminiInfo)
  expect(container.textContent).not.toContain('wants to use HarnessDesk')
})

it.each([
  ['mcp__harnessdesk__git_log', "Use the harnessdesk server's Git log tool"],
  ['find_files (harnessdesk MCP Server)', "Use the harnessdesk server's Find files tool"],
  ['mcp__other__git_log', 'mcp__other__git_log'],
  ['mcp__harnessdesk__edit_file', 'mcp__harnessdesk__edit_file'],
])('words a desk tool the agent names by its wire name, and leaves any other title as sent: %s', (summary, shown) => {
  mount(boardApproval(summary, SESSION_SET), info)
  expect(container.textContent).toContain(shown)
  if (shown !== summary) expect(container.textContent).not.toContain(summary)
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


it('renders a structured multiline permission command as preformatted code', () => {
  const command = "cat > synthetic.txt <<'END'\n  line one\nline two\nEND"
  mount({ ...boardApproval('Run this command?', SESSION_SET), facts: [{ label: 'Command', value: command }] })
  const code = container.querySelector('pre')
  expect(code?.textContent).toBe(command)
  expect(container.textContent?.split(command)).toHaveLength(2)
  expect(container.textContent).not.toContain('Unicode escapes')
})


it('preserves a command summary for authority while rendering a concise heading', () => {
  const command = "cat > synthetic.txt <<'END'\n  line one\nline two\nEND"
  mount({ ...boardApproval(command, SESSION_SET), facts: [{ label: 'Command', value: command }] })
  expect(container.textContent).toContain('Run this command?')
  expect(container.querySelector('pre')?.textContent).toBe(command)
  expect(container.textContent?.split(command)).toHaveLength(2)
})

it('keeps an unrelated permission title with a command fact', () => {
  mount({ ...boardApproval('Execute tool', SESSION_SET), facts: [{ label: 'Command', value: 'git status' }] })
  expect(container.textContent).toContain('Execute tool')
  expect(container.querySelector('pre')?.textContent).toBe('git status')
})

it.each([
  ['BEL', '\u0007', '\\u0007'],
  ['ST', '\u001b\\', '\\u001b\\'],
])('keeps executable lines inside an OSC span visible with the %s terminator', (_name, terminator, shownTerminator) => {
  // These are display fixtures only: the line inside the terminal title must
  // remain readable when the identical summary is replaced by a short heading.
  const inner = "printf 'inside OSC\\n'"
  const command = `printf 'before\\n'\n# \u001b]0;title\n${inner}\n# ${terminator}\nprintf 'after\\n'`
  const shown = `printf 'before\\n'\n# \\u001b]0;title\n${inner}\n# ${shownTerminator}\nprintf 'after\\n'`
  const facts = Object.freeze([Object.freeze({ label: 'Command', value: command })])
  const approval = Object.freeze({ ...boardApproval(command, SESSION_SET), facts })
  const store = mount(approval)

  const code = container.querySelector('pre')
  expect(code?.textContent).toContain(inner)
  expect(code?.textContent).toBe(shown)
  expect(container.querySelector('h2')?.textContent).toBe('Run this command?')
  expect(container.textContent).toContain('Control and invisible characters are shown as Unicode escapes.')
  expect(store.getSnapshot().approvals[0]?.approval).toBe(approval)
  expect(approval.summary).toBe(command)
  expect(approval.facts).toBe(facts)
  expect(approval.facts[0]?.value).toBe(command)
  const allow = approval.options.find(option => option.intent === 'approve')!
  act(() => buttonsOf().find(button => button.getAttribute('aria-label') === allow.label)!.click())
  expect(store.respondToApproval).toHaveBeenCalledWith(KEY, approval.id, { type: 'option', optionId: allow.id })
})

it.each([
  ['CSI', '\u001b[31mred\u001b[0m', '\\u001b[31mred\\u001b[0m'],
  ['C0 controls and CR', '\u0000\u0008\u000b\u000c\r\u001f\u007f', '\\u0000\\u0008\\u000b\\u000c\\u000d\\u001f\\u007f'],
  ['C1 controls', '\u0085\u009b31m\u009dtitle\u009c', '\\u0085\\u009b31m\\u009dtitle\\u009c'],
  ['Bidi and format', '\u202eabc\u202c\u2066def\u2069\u200b\ufeff', '\\u202eabc\\u202c\\u2066def\\u2069\\u200b\\ufeff'],
  ['line and paragraph separators', '\u2028\u2029', '\\u2028\\u2029'],
  ['unpaired surrogates', '\ud800x\udfff', '\\ud800x\\udfff'],
  ['supplementary format', '\u{e0001}', '\\u{e0001}'],
])('shows %s as Unicode escapes while preserving literal markup, newlines and tabs', (_name, raw, shown) => {
  const command = `printf '<script>literal & text</script> 😀'\n\t${raw}\nprintf 'tail'`
  const approval = { ...boardApproval(command, SESSION_SET), facts: [{ label: 'Command', value: command }] }
  mount(approval)

  const code = container.querySelector('pre')
  expect(code?.textContent).toBe(`printf '<script>literal & text</script> 😀'\n\t${shown}\nprintf 'tail'`)
  expect(code?.querySelector('script')).toBeNull()
  expect(container.textContent).toContain('Control and invisible characters are shown as Unicode escapes.')
  expect(approval.summary).toBe(command)
  expect(approval.facts[0]?.value).toBe(command)
})

it.each([
  ['/work/storefront/packages/ui', 'storefront/packages/ui'],
  ['/work/other-checkout', '~/other-checkout'],
])('locates a permission command in its actual folder %s instead of the session folder', (cwd, shown) => {
  mount({ ...boardApproval('Execute tool', SESSION_SET), cwd, facts: [{ label: 'Command', value: 'git status' }] }, info, {
    home: '/work',
    workspace: { path: '/work/workspace', name: 'workspace', lastOpenedAt: 0 },
    sessions: new Map([[KEY, {
      id: SESSION as never, runtime: RUNTIME, cwd: '/work/storefront', status: { type: 'idle' as const },
      createdAt: 0, updatedAt: 0, turns: [], itemsLoaded: true,
    }]]),
  })

  const folder = container.querySelector('[data-slot="approval-meta"][data-kind="folder"]')
  expect(folder?.getAttribute('title')).toBe(cwd)
  expect(folder?.textContent).toBe(`in${shown}`)
  expect(container.querySelectorAll('[data-kind="folder"]')).toHaveLength(1)
  expect(container.querySelector('pre')?.textContent).toBe('git status')
})

it('keeps a permission command without cwd free of an inferred session folder', () => {
  mount({ ...boardApproval('Execute tool', SESSION_SET), facts: [{ label: 'Command', value: 'git status' }] })
  expect(container.querySelector('[data-kind="folder"]')).toBeNull()
})

it('preserves legacy permission facts and scope without applying command presentation', () => {
  mount({
    ...boardApproval('Additional access', SESSION_SET), cwd: '/work/other-checkout',
    facts: [{ label: 'Tool', value: '\u001b[31mread <literal>\u001b[0m' }],
    reason: 'The file is outside the workspace.',
    filesystem: ['/work/other-checkout/file.txt'], network: ['example.com'],
  })
  expect(container.querySelector('h2')?.textContent).toBe('Additional access')
  expect(container.querySelector('[data-slot="approval-meta"]')?.textContent).toBe('Toolread <literal>')
  expect(container.querySelector('pre')).toBeNull()
  expect(container.querySelector('[data-kind="folder"]')).toBeNull()
  expect(container.textContent).toContain('The file is outside the workspace.')
  expect(container.textContent).toContain('Filesystem/work/other-checkout/file.txt')
  expect(container.textContent).toContain('Networkexample.com')
  expect(container.textContent).not.toContain('Unicode escapes')
})
