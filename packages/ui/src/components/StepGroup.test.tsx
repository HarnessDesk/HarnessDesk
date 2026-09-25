import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type { AgentItem } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { StepGroup } from './StepGroup'
import own from './StepGroup.module.css'
import sheet from './StepGroup.module.css?raw'

/**
 * A burst of templated steps, folded under its count.
 *
 * In a turn's work fold the steps are lines, not cards, and an open group
 * hangs them under its own words: indented by the space its chevron and glyph
 * take, keeping each step's own rhythm rather than reaching in to reset it.
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

const read = (id: string, path: string, status = 'completed'): AgentItem =>
  ({
    id,
    type: 'command',
    command: `cat ${path}`,
    cwd: '/work',
    origin: 'agent',
    actions: [{ type: 'read', command: `cat ${path}`, name: path, path }],
    status,
    output: '',
    exitCode: 0,
  }) as unknown as AgentItem

it('hangs an open group’s steps under its words in the light register, each keeping its own rhythm', () => {
  const snapshot = emptySnapshot()
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <StepGroup items={[read('a', 'src/a.ts'), read('b', 'src/b.ts', 'inProgress')]} running root="/work" register="light" />
      </StoreProvider>,
    )
  })
  const body = container.querySelector<HTMLElement>(`.${own.body}`)
  expect(body?.dataset['register']).toBe('light')
  // Indented to the summary's words: the group's own left margin is the fold's indent.
  expect(sheet).toMatch(/\.body\[data-register='light'\]\s*\{[^}]*margin:[^;]*var\(--hd-space-5\)/s)
  // Each step is a transcript item at the light rhythm, not reset by the body.
  const steps = [...(body?.children ?? [])] as HTMLElement[]
  expect(steps).toHaveLength(2)
  for (const step of steps) {
    expect(step.dataset['slot']).toBe('turn-item')
    expect(step.className).toContain('py-(--hd-space-px)')
  }
  // Open while running, and the running mark is the system spinner.
  expect(container.querySelector('[data-slot="disclosure-chevron"]')?.hasAttribute('data-open')).toBe(true)
  expect(container.querySelector('[data-slot="spinner"]')?.getAttribute('data-size')).toBe('sm')
})
