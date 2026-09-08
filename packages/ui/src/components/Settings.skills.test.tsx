import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeInfo, SkillInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { SkillsSection } from './Settings'

/**
 * The skills list, readable.
 *
 * A skill's wire name and its full trigger paragraph are what the model
 * reads; a person scanning a list of 116 needs the display name, one clamped
 * line, and where it came from — with the full text one click away rather
 * than twelve lines tall in the row. Codex ships all of that metadata
 * (displayName, shortDescription, scope) and the page now uses it.
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

const runtime = (): RuntimeInfo =>
  ({
    id: 'codex',
    name: 'OpenAI Codex',
    capabilities: { skills: true },
    presentation: { name: 'OpenAI Codex' },
  }) as unknown as RuntimeInfo

const SKILLS: SkillInfo[] = [
  {
    name: 'add-admin-task',
    description:
      'Converts a task description into an executable, verifiable admin task with clear success criteria and browsermcp test steps. A very long paragraph the row must not show in full.',
    shortDescription: 'Add a testable unchecked task to admin-task.md',
    enabled: true,
    path: '/Users/someone/.codex/skills/add-admin-task/SKILL.md',
    scope: 'user',
  },
  {
    name: 'benchmark',
    description: 'Performance regression detection using the browse daemon.',
    enabled: true,
    path: '/repo/.codex/skills/benchmark/SKILL.md',
    scope: 'repo',
    displayName: 'Benchmark',
  },
]

const mount = (skills: SkillInfo[] = SKILLS): { onUse: ReturnType<typeof vi.fn> } => {
  const info = runtime()
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: info.id,
    runtimes: [info],
    skills,
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    setSkillEnabled: vi.fn(async () => {}),
  } as unknown as AppStore
  const onUse = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <SkillsSection onUse={onUse} />
      </StoreProvider>,
    )
  })
  return { onUse }
}

it('a wire name becomes a sentence and the row shows the short description with its scope', () => {
  mount()
  expect(container.textContent).toContain('Add Admin Task')
  expect(container.textContent).not.toContain('add-admin-task')
  expect(container.textContent).toContain('Add a testable unchecked task to admin-task.md')
  // The row keeps the one-liner; the trigger paragraph stays off the list.
  expect(container.textContent).not.toContain('browsermcp test steps')
  expect(container.textContent).toContain('Personal')
  expect(container.textContent).toContain('Project')
})

it('opening a skill shows the full text, the identifier, and Use in composer', () => {
  const { onUse } = mount()
  const row = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Add Admin Task'),
  )
  act(() => row?.click())

  expect(container.textContent).toContain('browsermcp test steps')
  expect(container.textContent).toContain('add-admin-task')
  expect(container.textContent).toContain('Where it lives')

  const composed: string[] = []
  const listener = (event: Event): void => {
    composed.push(String((event as CustomEvent).detail))
  }
  window.addEventListener('harnessdesk:compose', listener)
  const use = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Use in composer',
  )
  act(() => use?.click())
  window.removeEventListener('harnessdesk:compose', listener)

  expect(composed).toEqual(['@add-admin-task '])
  expect(onUse).toHaveBeenCalled()
})

it('a scope that is really a scanned folder is not worn as a label', () => {
  mount([
    {
      name: 'stray',
      description: 'Old snapshot shape.',
      enabled: true,
      scope: '/Users/someone/repo',
    },
  ])
  expect(container.textContent).not.toContain('/Users/someone/repo')
})
