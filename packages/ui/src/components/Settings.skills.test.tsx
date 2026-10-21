import { SkillsTestPage as SkillsSection } from '../test-support/settings-page'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeInfo, SkillInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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
    path: '/home/dev/.agent/skills/add-admin-task/SKILL.md',
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

const mount = (name: string | null = null, active = true) => {
  const info = runtime()
  const snapshot = { ...emptySnapshot(), status: 'open', activeRuntime: info.id, runtimes: [info], skills: SKILLS } as AppSnapshot
  const view = { filter: 'all', query: 'saved search', chip: 'all', view: 'list', skillView: 'cards' }
  const openDestination = vi.fn(), setLibraryView = vi.fn(), onUse = vi.fn()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot,
    libraryView: () => view, setLibraryView, openDestination, setSkillEnabled: vi.fn(async () => {}) } as unknown as AppStore
  act(() => root.render(<StoreProvider store={store}><SkillsSection name={name} active={active} onUse={onUse} /></StoreProvider>))
  return { openDestination, setLibraryView, onUse }
}

it('redirects legacy Skills to the runtime scope in Customize', () => {
  const name = null
  const { openDestination, setLibraryView } = mount(name)
  expect(setLibraryView).toHaveBeenCalledWith('skill', expect.objectContaining({ runtime: runtime().id, query: 'saved search' }))
  expect(openDestination).toHaveBeenCalledWith({ kind: 'library', section: 'skill' })
  expect(container.querySelector('[data-slot="row"]')).toBeNull()
})

it('does not redirect from a retained inactive Settings page', () => {
  const { openDestination } = mount(null, false)
  expect(openDestination).not.toHaveBeenCalled()
})

it('retains native command details and returns directly to Customize', () => {
  const { openDestination, setLibraryView } = mount('add-admin-task')
  expect(container.textContent).toContain('browsermcp test steps')
  expect(container.textContent).toContain('add-admin-task')
  expect(container.textContent).toContain('Where it lives')
  expect(openDestination).not.toHaveBeenCalled()
  const back = [...container.querySelectorAll('button')].find(button => button.textContent === 'Back to Customize')!
  act(() => back.click())
  expect(setLibraryView).toHaveBeenCalledWith('skill', expect.objectContaining({ runtime: runtime().id }))
  expect(openDestination).toHaveBeenCalledWith({ kind: 'library', section: 'skill' })
})

it('still hands a native command to the composer', () => {
  const { onUse } = mount('add-admin-task')
  const composed: string[] = []
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{text:string;onReceived:()=>void}>).detail
    composed.push(detail.text); detail.onReceived()
  }
  window.addEventListener('harnessdesk:compose', listener)
  try {
    const use = [...container.querySelectorAll('button')].find(button => button.textContent === 'Use in composer')!
    act(() => use.click())
    expect(composed).toEqual(['@add-admin-task '])
    expect(onUse).toHaveBeenCalledOnce()
  } finally { window.removeEventListener('harnessdesk:compose', listener) }
})


it('keeps a missing command route readable while its runtime catalogue can still update', () => {
  const { openDestination } = mount('missing-command')
  expect(container.textContent).toContain('Command not found')
  expect(container.textContent).toContain('Back to Customize')
  expect(openDestination).not.toHaveBeenCalled()
})
