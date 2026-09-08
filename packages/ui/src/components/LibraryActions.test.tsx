import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { runtimeId } from '@harnessdesk/protocol'
import type {
  Library,
  LibraryEntry,
  LibraryIntent,
  LibraryOpResult,
  LibraryPlan,
  ReachState,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import type { AppStore } from '../state/store'
import {
  AuthorDialog,
  ImportDialog,
  PlanDialog,
  ResolveDialog,
  type LibraryColumn,
} from './LibraryActions'

/** The home every `~/…` path in these fixtures hangs off; the page prints them back with the tilde. */
const HOME = '/home/u'

/**
 * The library's verbs.
 *
 * What is under test is the two-step contract, not the markup: nothing is
 * asked of the host but a plan until the person confirms, the confirmation
 * sends back exactly the ops that were previewed, and refusals are shown
 * with their reasons rather than filtered out of the list. The flows that
 * gather input (import, resolve, author) are tested on what they *emit* —
 * intents — because everything after that is the host's word, not theirs.
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

const columns: readonly LibraryColumn[] = [
  { id: runtimeId('one'), label: 'First Agent' },
  { id: runtimeId('two'), label: 'Second Agent' },
]

const storeWith = (
  request: (method: string, params: unknown) => Promise<unknown>,
): AppStore =>
  ({
    subscribe: () => () => {},
    getSnapshot: () => ({}),
    transport: { request },
  }) as unknown as AppStore

const render = async (store: AppStore, node: React.ReactNode): Promise<void> => {
  await act(async () => {
    root.render(<StoreProvider store={store}>{node}</StoreProvider>)
  })
}

const click = async (button: Element | null | undefined): Promise<void> => {
  expect(button, 'expected a button to click').toBeTruthy()
  await act(async () => {
    ;(button as HTMLButtonElement).click()
  })
}

const buttonNamed = (text: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find((one) => one.textContent?.includes(text))

const plan = (ops: LibraryPlan['ops']): LibraryPlan => ({ plannedAt: 1, ops })

it('previews before it applies, and applies exactly what was previewed', async () => {
  const ops: LibraryPlan['ops'] = [
    {
      id: 'op-1',
      kind: 'skill',
      name: 'commit',
      action: 'create',
      targetPath: '/home/u/.claude/skills/commit',
      targetRuntime: runtimeId('two'),
      preview: '--- /dev/null\n+++ x\n@@ -0,0 +1,1 @@\n+Body',
      content: 'Body',
      guardDigest: null,
      backup: false,
    },
    {
      id: 'op-2',
      kind: 'skill',
      name: 'commit',
      action: 'refuse',
      targetPath: '/home/u/.codex/skills/commit',
      reason: 'A different copy already sits here.',
      guardDigest: null,
      backup: false,
    },
  ]
  const calls: { method: string; params: unknown }[] = []
  const results: readonly LibraryOpResult[] = [
    { id: 'op-1', outcome: 'done' },
    { id: 'op-2', outcome: 'skipped', detail: 'refused' },
  ]
  const store = storeWith(async (method, params) => {
    calls.push({ method, params })
    if (method === 'library/plan') return plan(ops)
    if (method === 'library/apply') return results
    throw new Error(`unexpected ${method}`)
  })
  const applied = vi.fn()
  const intents: readonly LibraryIntent[] = [
    { kind: 'installSkill', name: 'commit', sourcePath: '/s', targetRuntime: runtimeId('two') },
  ]
  await render(
    store,
    <PlanDialog title="Install commit" intents={intents} columns={columns} onClose={() => {}} onApplied={applied} />,
  )

  // The refusal is on screen with its reason, and only one change is offered.
  expect(container.textContent).toContain('A different copy already sits here.')
  expect(container.textContent).toContain('1 change, previewed below')
  expect(calls.map((one) => one.method)).toEqual(['library/plan'])

  await click(buttonNamed('Apply 1 change'))
  expect(calls.map((one) => one.method)).toEqual(['library/plan', 'library/apply'])
  expect((calls[1]?.params as { ops: unknown }).ops).toEqual(ops)
  expect(applied).toHaveBeenCalledOnce()
  expect(container.querySelector('[data-testid="apply-summary"]')?.textContent).toContain(
    '1 change made, 1 skipped.',
  )
})

it('a failed op wears its reason after apply; the batch reports per op', async () => {
  const ops: LibraryPlan['ops'] = [
    {
      id: 'op-1',
      kind: 'skill',
      name: 'a',
      action: 'create',
      targetPath: '/t/a',
      content: 'x',
      guardDigest: null,
      backup: false,
    },
    {
      id: 'op-2',
      kind: 'skill',
      name: 'b',
      action: 'create',
      targetPath: '/t/b',
      content: 'x',
      guardDigest: null,
      backup: false,
    },
  ]
  const store = storeWith(async (method) => {
    if (method === 'library/plan') return plan(ops)
    return [
      { id: 'op-1', outcome: 'failed', detail: 'The target changed since the preview.' },
      { id: 'op-2', outcome: 'done' },
    ]
  })
  await render(
    store,
    <PlanDialog title="Install" intents={[]} columns={columns} onClose={() => {}} onApplied={() => {}} />,
  )
  await click(buttonNamed('Apply 2 changes'))
  expect(container.textContent).toContain('The target changed since the preview.')
  expect(container.querySelector('[data-testid="apply-summary"]')?.textContent).toContain(
    '1 change made, 1 failed.',
  )
})

const entryWith = (
  name: string,
  states: readonly ReachState[],
  over: Partial<LibraryEntry> = {},
): LibraryEntry => ({
  kind: 'skill',
  name,
  title: null,
  description: null,
  copies: [
    {
      path: `/home/u/.codex/skills/${name}`,
      scope: 'user',
      readBy: [runtimeId('one')],
      hollow: false,
      digest: 'abc',
      readOnly: false,
    },
  ],
  reach: states.map((state, index) => ({
    runtime: runtimeId(index === 0 ? 'one' : 'two'),
    state,
    basis: 'scanned' as const,
  })),
  ...over,
})

const libraryWith = (entries: readonly LibraryEntry[]): Library => ({
  generatedAt: 1,
  home: HOME,
  runtimes: [runtimeId('one'), runtimeId('two')],
  // A location row per agent and kind, as a real scan always carries: the
  // import dialog only offers targets the table knows how to write to.
  locations: (['one', 'two'] as const).flatMap((id) =>
    (['skill', 'mcp'] as const).map((kind) => ({
      runtime: runtimeId(id),
      kind,
      path: kind === 'skill' ? `/home/u/.${id}/skills` : `/home/u/.${id}.json`,
      scope: 'user' as const,
      scanned: true,
      exists: true,
      readOnly: false,
    })),
  ),
  entries: [...entries],
  gaps: [],
})

it('import offers what the source loads and the target lacks, as intents', async () => {
  const value = libraryWith([
    entryWith('carried', ['reaches', 'absent']),
    entryWith('everywhere', ['reaches', 'reaches']),
    entryWith('stranded', ['reaches', 'unscanned']),
  ])
  const onPlan = vi.fn()
  await render(
    storeWith(async () => ({})),
    <ImportDialog library={value} columns={columns} onClose={() => {}} onPlan={onPlan} />,
  )

  await click(
    [...container.querySelectorAll('[role="radio"]')].find((one) => one.textContent === 'First Agent'),
  )
  const intoSecond = [...container.querySelectorAll('[role="radio"]')].filter(
    (one) => one.textContent === 'Second Agent',
  )
  await click(intoSecond[intoSecond.length - 1])

  // What already reaches everywhere is not a candidate.
  expect(container.textContent).toContain('carried')
  expect(container.textContent).toContain('stranded')
  expect(container.textContent).not.toContain('everywhere')

  await click(buttonNamed('Preview 2 imports'))
  expect(onPlan).toHaveBeenCalledOnce()
  const intents = onPlan.mock.calls[0]?.[1] as readonly LibraryIntent[]
  expect(intents).toEqual([
    {
      kind: 'installSkill',
      name: 'carried',
      sourcePath: '/home/u/.codex/skills/carried',
      targetRuntime: runtimeId('two'),
    },
    {
      kind: 'installSkill',
      name: 'stranded',
      sourcePath: '/home/u/.codex/skills/stranded',
      targetRuntime: runtimeId('two'),
    },
  ])
})

it('a deselected candidate stays home', async () => {
  const value = libraryWith([
    entryWith('carried', ['reaches', 'absent']),
    entryWith('stranded', ['reaches', 'absent']),
  ])
  const onPlan = vi.fn()
  await render(
    storeWith(async () => ({})),
    <ImportDialog library={value} columns={columns} onClose={() => {}} onPlan={onPlan} />,
  )
  await click(
    [...container.querySelectorAll('[role="radio"]')].find((one) => one.textContent === 'First Agent'),
  )
  const intoSecond = [...container.querySelectorAll('[role="radio"]')].filter(
    (one) => one.textContent === 'Second Agent',
  )
  await click(intoSecond[intoSecond.length - 1])
  // A checkbox: these rows are items picked out of a list, not settings that
  // take effect where they stand.
  await click(container.querySelector('[role="checkbox"][aria-label="Import carried"]'))
  await click(buttonNamed('Preview 1 import'))
  const intents = onPlan.mock.calls[0]?.[1] as readonly LibraryIntent[]
  expect(intents.map((one) => one.name)).toEqual(['stranded'])
})

it('resolving makes the person pick the winner, then syncs the rest', async () => {
  const entry = entryWith('split', ['differs', 'reaches'], {
    copies: [
      {
        path: '/home/u/.codex/skills/split',
        scope: 'user',
        readBy: [runtimeId('one')],
        hollow: false,
        digest: 'aaa',
        readOnly: false,
      },
      {
        path: '/home/u/.claude/skills/split',
        scope: 'user',
        readBy: [runtimeId('two')],
        hollow: false,
        digest: 'bbb',
        readOnly: false,
      },
      {
        path: '/home/u/.agents/skills/split',
        scope: 'user',
        readBy: [],
        hollow: true,
        digest: null,
        readOnly: false,
      },
    ],
  })
  const onPlan = vi.fn()
  await render(
    storeWith(async () => ({})),
    <ResolveDialog entry={entry} columns={columns} onClose={() => {}} onPlan={onPlan} />,
  )

  const preview = buttonNamed('Preview the resolution')
  expect(preview?.disabled, 'no winner picked yet').toBe(true)

  await click(
    [...container.querySelectorAll('[role="radio"]')].find((one) =>
      one.textContent?.includes('/home/u/.codex/skills/split'),
    ),
  )
  await click(buttonNamed('Preview the resolution'))
  const intents = onPlan.mock.calls[0]?.[1] as readonly LibraryIntent[]
  expect(intents).toEqual([
    {
      kind: 'syncSkill',
      name: 'split',
      sourcePath: '/home/u/.codex/skills/split',
      targetPaths: ['/home/u/.claude/skills/split'],
    },
    { kind: 'removeCopy', name: 'split', path: '/home/u/.agents/skills/split' },
  ])
})

it('authoring composes the frontmatter and refuses a name that cannot be a directory', async () => {
  const onPlan = vi.fn()
  await render(
    storeWith(async () => ({})),
    <AuthorDialog columns={columns} onClose={() => {}} onPlan={onPlan} />,
  )
  const inputs = [...container.querySelectorAll('input')]
  const textarea = container.querySelector('textarea')

  await act(async () => {
    const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    const setArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setInput?.call(inputs[0], 'Release Notes')
    inputs[0]?.dispatchEvent(new Event('input', { bubbles: true }))
    setInput?.call(inputs[1], 'Writes the release notes')
    inputs[1]?.dispatchEvent(new Event('input', { bubbles: true }))
    setArea?.call(textarea, 'Read the changelog, write the notes.')
    textarea?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  // The agent picker is the app's own switcher in its many-valued form —
  // the same control the import dialog's From/To use, so it is visible before
  // it is pressed.
  await click(
    [...container.querySelectorAll('[data-slot="toggle-group-item"]')].find(
      (one) => one.textContent === 'Second Agent',
    ),
  )
  await click(buttonNamed('Preview the install'))

  expect(onPlan).toHaveBeenCalledOnce()
  const intents = onPlan.mock.calls[0]?.[1] as readonly LibraryIntent[]
  expect(intents).toEqual([
    {
      kind: 'authorSkill',
      name: 'release-notes',
      content:
        '---\nname: release-notes\ndescription: Writes the release notes\n---\n\nRead the changelog, write the notes.\n',
      targetRuntimes: [runtimeId('two')],
    },
  ])
})

it('the import direction can be reversed on a machine with exactly two agents', async () => {
  /*
   * The deadlock this fixes. Each picker used to grey out whatever the other
   * one held, which reads as "not that one" and works — until there are only
   * two agents. Then From holds A with B greyed, To holds B with A greyed,
   * pressing the one already chosen is ignored (that is what stops a stray
   * click emptying a picker), and no press anywhere reverses the direction.
   * Somebody with Claude and Cursor could import one way and never the other.
   */
  const value = libraryWith([entryWith('carried', ['reaches', 'absent'])])
  const onPlan = vi.fn()
  await render(
    storeWith(async () => ({})),
    <ImportDialog library={value} columns={columns} onClose={() => {}} onPlan={onPlan} />,
  )
  const picks = () => [...container.querySelectorAll('[data-slot="toggle-group-item"]')]
  const side = (name: string, which: 0 | 1): Element => {
    const hit = picks().filter((one) => one.textContent === name)[which]
    expect(hit, `no ${which === 0 ? 'From' : 'To'} option named ${name}`).toBeTruthy()
    return hit as Element
  }
  const from = (name: string) => side(name, 0)
  const into = (name: string) => side(name, 1)

  await click(from('First Agent'))
  await click(into('Second Agent'))
  expect(buttonNamed('Preview 1 import')).toBeTruthy()

  // Nothing is disabled — every option in both pickers is pressable.
  expect(picks().every((one) => !(one as HTMLButtonElement).disabled)).toBe(true)

  // Press the agent the other side is holding: the pair reverses rather than
  // colliding, which is the plainest way to say "the other direction".
  await click(from('Second Agent'))
  expect(from('Second Agent').getAttribute('data-state')).toBe('on')
  expect(into('First Agent').getAttribute('data-state')).toBe('on')

  // And it is a real direction, not just two highlights: the plan now goes
  // the other way. The copy has to belong to the *source* — an import from
  // Second Agent carries the copy Second Agent reads, never some other
  // agent's copy of the same name.
  const reversed = libraryWith([
    entryWith('carried', ['absent', 'reaches'], {
      copies: [
        {
          path: '/home/u/.claude/skills/carried',
          scope: 'user',
          readBy: [runtimeId('two')],
          hollow: false,
          digest: 'abc',
          readOnly: false,
        },
      ],
    }),
  ])
  await render(
    storeWith(async () => ({})),
    <ImportDialog library={reversed} columns={columns} onClose={() => {}} onPlan={onPlan} />,
  )
  await click(
    [...container.querySelectorAll('[data-slot="toggle-group-item"]')].filter(
      (one) => one.textContent === 'Second Agent',
    )[0],
  )
  await click(
    [...container.querySelectorAll('[data-slot="toggle-group-item"]')].filter(
      (one) => one.textContent === 'First Agent',
    )[1],
  )
  // Every candidate is included until somebody says otherwise, so there is
  // nothing to tick — press the confirm.
  await click(buttonNamed('Preview 1 import'))
  const intents = onPlan.mock.calls[0]?.[1] as readonly LibraryIntent[]
  expect(
    intents.map((one) => ('targetRuntime' in one ? one.targetRuntime : null)),
  ).toEqual([runtimeId('one')])
})
