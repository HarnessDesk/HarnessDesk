import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import css from './Settings.module.css?raw'
import { NoteList, PageHead, Row, RowChoice, Text } from './Settings'

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

it('sets PageHead and the page text role on the wordmark type', () => {
  act(() => root.render(
    <>
      <PageHead title="General" />
      <Text role="wordmark">HarnessDesk</Text>
      <Text role="page">Appearance</Text>
    </>,
  ))

  const wordmark = container.querySelector<HTMLElement>('[data-role="wordmark"]')
  const page = container.querySelector<HTMLElement>('[data-role="page"]')
  expect(page?.className).toContain('text-(length:--hd-heading)')
  expect(page?.className).toContain('leading-(--hd-line-heading)')
  expect(page?.className).toContain('font-semibold')
  // The heading face and its tracking are tokens, so a foundation moves both.
  expect(page?.className).toContain('font-(family-name:--hd-font-heading)')
  expect(page?.className).toContain('tracking-(--hd-tracking-heading)')
  const typeClasses = (node: HTMLElement | null) => node?.className
    .split(' ')
    .filter(name => /^(?:text-\(length|leading-|font-|tracking-)/.test(name))
  expect(typeClasses(page)).toEqual(typeClasses(wordmark))
  expect(css).toMatch(/\.pageTitle\s*{[^}]*font-size:\s*var\(--hd-heading\)/s)
  expect(css).toMatch(/\.pageTitle\s*{[^}]*line-height:\s*var\(--hd-line-heading\)/s)
  expect(css).toMatch(/\.pageTitle\s*{[^}]*font-weight:\s*var\(--hd-weight-semibold\)/s)
  expect(css).toMatch(/\.pageTitle\s*{[^}]*font-family:\s*var\(--hd-font-heading\)/s)
  expect(css).toMatch(/\.pageTitle\s*{[^}]*letter-spacing:\s*var\(--hd-tracking-heading\)/s)
})

it('can preserve the end of a truncated path', () => {
  act(() => root.render(<Text truncateFrom="start">packages/ui/src/Composer.tsx</Text>))
  const text = container.querySelector('[data-slot="text"]')
  expect(text?.getAttribute('data-truncate-from')).toBe('start')
  expect(text?.className).toContain('[direction:rtl]')
  expect(text?.className).toContain('text-left')
})

it('lets a narrow choice deliver its consequence whole', () => {
  act(() => root.render(
    <RowChoice title="Summary" desc="The goal, exchanges, files and tasks." selected onClick={() => {}} />,
  ))
  expect(container.querySelector('[data-wrap="true"]')?.textContent).toContain('files and tasks')
})

it('moves and selects radio choices with arrow keys', () => {
  const chooseSummary = vi.fn()
  const chooseTranscript = vi.fn()
  act(() => root.render(
    <div role="radiogroup" aria-label="What to carry">
      <RowChoice title="Summary" selected onClick={chooseSummary} />
      <RowChoice title="Transcript" selected={false} onClick={chooseTranscript} />
    </div>,
  ))

  const radios = container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
  radios[0]?.focus()
  act(() => radios[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))

  expect(chooseTranscript).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(radios[1])
})

it('skips disabled radio choices during roving keyboard selection', () => {
  const chooseFirst = vi.fn()
  const chooseDisabled = vi.fn()
  const chooseLast = vi.fn()
  act(() => root.render(
    <div role="radiogroup" aria-label="Permission">
      <RowChoice title="First" selected onClick={chooseFirst} />
      <RowChoice title="Unavailable" selected={false} disabled onClick={chooseDisabled} />
      <RowChoice title="Last" selected={false} onClick={chooseLast} />
    </div>,
  ))

  const radios = container.querySelectorAll<HTMLButtonElement>('[role="radio"]')
  radios[0]?.focus()
  act(() => radios[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))

  expect(chooseDisabled).not.toHaveBeenCalled()
  expect(chooseLast).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(radios[2])
})

it('keeps a short list of note details semantically grouped', () => {
  act(() => root.render(<NoteList><li>flow.yaml — unknown role</li></NoteList>))
  const list = container.querySelector('[data-slot="note-list"]')
  expect(list?.tagName).toBe('UL')
  expect(list?.textContent).toContain('unknown role')
})

it('lets the named text role carry list-item semantics', () => {
  act(() => root.render(<Text as="li" role="value">Run the checks</Text>))
  const text = container.querySelector('[data-slot="text"]')
  expect(text?.tagName).toBe('LI')
  expect(text?.getAttribute('data-role')).toBe('value')
})

it('a description that is a name or a path gives way on one line; a sentence wraps', () => {
  act(() => root.render(
    <>
      <Row title="Worktree" desc="~/code/HarnessDesk/.claude/worktrees/a-very-long-branch-name" truncateDesc />
      <Row title="Backup" desc="Runtimes, your Agents and their seats on this Mac, in one file." />
    </>,
  ))
  const [path, sentence] = [...container.querySelectorAll<HTMLElement>('[class*="rowDesc"]')]
  expect(path?.hasAttribute('data-wrap')).toBe(false)
  expect(path?.className).toMatch(/rowDescTruncate/)
  expect(sentence?.getAttribute('data-wrap')).toBe('true')
  expect(sentence?.className).not.toMatch(/rowDescTruncate/)
  expect(css).toMatch(/\.rowDescTruncate\s*{[^}]*white-space:\s*nowrap/s)
})
