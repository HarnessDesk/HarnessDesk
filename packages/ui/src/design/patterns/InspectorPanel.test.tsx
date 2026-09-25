import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { GroupLine, PanelRow } from './InspectorPanel'

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

it('keeps a sticky group line on the panel ground, and an ordinary one in the flow', () => {
  act(() => root.render(
    <>
      <GroupLine left="Turn 1" right="1.2s" sticky />
      <GroupLine left="This turn · 2 files" />
    </>,
  ))
  const [sticky, plain] = [...container.querySelectorAll<HTMLElement>('[data-slot="inspector-group"]')]
  expect(sticky?.hasAttribute('data-sticky')).toBe(true)
  expect(sticky?.className).toContain('sticky top-0')
  expect(sticky?.className).toContain('bg-(--hd-background)')
  expect(plain?.hasAttribute('data-sticky')).toBe(false)
  expect(plain?.className).not.toContain('sticky')
})

it('says who produced a row before its mark, at the meta step and in the words given', () => {
  act(() => root.render(<PanelRow lead="Shell" mark={<span data-testid="mark" />} title="git status" />))
  const row = container.querySelector<HTMLElement>('[data-slot="inspector-row"]')
  const lead = row?.firstElementChild as HTMLElement | null
  expect(lead?.textContent).toBe('Shell')
  expect(lead?.dataset['role']).toBe('meta')
  expect(lead?.nextElementSibling?.getAttribute('data-slot')).toBe('inspector-row-mark')
  expect(lead?.className).not.toContain('uppercase')
})
