import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { CodeText, Keycap, SearchMatch, Text, TextMark } from './Settings'
import styles from './Settings.module.css'

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

it('names its role and carries tone, truncation, and numeric semantics', () => {
  act(() =>
    root.render(
      <Text as="strong" role="figure" tone="warning" truncate numeric>
        12%
      </Text>,
    ),
  )
  const text = container.firstElementChild as HTMLElement | null
  expect(text?.tagName).toBe('STRONG')
  expect(text?.dataset['slot']).toBe('text')
  expect(text?.dataset['role']).toBe('figure')
  expect(text?.dataset['tone']).toBe('warning')
  expect(text?.className).toContain('text-(--hd-warning-ink)')
  expect(text?.className).not.toContain('text-(--hd-foreground)')
  expect(text?.className).toContain('truncate')
  expect(text?.className).toContain('tabular-nums')
})

it('keeps the wordmark and navigation-name roles distinct from page and row titles', () => {
  act(() =>
    root.render(
      <>
        <Text role="wordmark">HarnessDesk</Text>
        <Text role="navigation" tint="violet" fade>Make the webhook receiver reliable</Text>
      </>,
    ),
  )

  const wordmark = container.querySelector<HTMLElement>('[data-role="wordmark"]')
  const navigation = container.querySelector<HTMLElement>('[data-role="navigation"]')
  expect(wordmark?.className).toContain('text-(length:--hd-heading)')
  expect(wordmark?.className).toContain('font-semibold')
  expect(navigation?.className).toContain('font-normal')
  expect(navigation?.className).toContain('text-(--hd-tint-violet-ink)')
  expect(navigation?.dataset['tint']).toBe('violet')
  expect(navigation?.className).toContain('[mask-image:var(--hd-fade)]')
  expect(navigation?.className).not.toContain('truncate')
})

it('owns the keycap and matched-text roles used by search surfaces', () => {
  act(() => root.render(
    <>
      <Keycap>esc</Keycap>
      <SearchMatch>sett</SearchMatch>
    </>,
  ))

  expect(container.querySelector('kbd[data-slot="keycap"]')?.textContent).toBe('esc')
  expect(container.querySelector('mark[data-slot="search-match"]')?.textContent).toBe('sett')
})

it('strikes a finished item through and steps it back, and leaves the rest alone', () => {
  act(() => root.render(<><Text role="navigation" done>Read it</Text><Text role="navigation">Fix it</Text></>))
  const [done, open] = [...container.querySelectorAll<HTMLElement>('[data-slot="text"]')]
  expect(done?.hasAttribute('data-done')).toBe(true)
  expect(done?.className).toContain('line-through')
  expect(done?.className).toContain('opacity-60')
  expect(open?.hasAttribute('data-done')).toBe(false)
  expect(open?.className).not.toContain('line-through')
})

it('sets code as a block only when asked', () => {
  act(() => root.render(<><CodeText as="pre" block>a = 1</CodeText><CodeText>inline</CodeText></>))
  const [block, inline] = [...container.querySelectorAll<HTMLElement>('[data-slot="code-text"]')]
  expect(block?.tagName).toBe('PRE')
  expect(block?.hasAttribute('data-block')).toBe(true)
  expect(inline?.hasAttribute('data-block')).toBe(false)
  expect(styles.monoBlock).toBeTruthy()
  expect(block?.classList.contains(styles.monoBlock!)).toBe(true)
  expect(inline?.classList.contains(styles.monoBlock!)).toBe(false)
})

it('gives a code block a muted plate and folded lines only when asked, and never to inline code', () => {
  act(() => root.render(<>
    <CodeText as="pre" block ground="muted" wrap>envelope</CodeText>
    <CodeText as="pre" block>file</CodeText>
    <CodeText ground="muted" wrap>inline</CodeText>
  </>))
  const [plate, bare, inline] = [...container.querySelectorAll<HTMLElement>('[data-slot="code-text"]')]
  expect(plate?.dataset['ground']).toBe('muted')
  expect(plate?.hasAttribute('data-wrap')).toBe(true)
  expect(bare?.hasAttribute('data-ground')).toBe(false)
  expect(bare?.hasAttribute('data-wrap')).toBe(false)
  expect(inline?.hasAttribute('data-ground')).toBe(false)
  expect(inline?.hasAttribute('data-wrap')).toBe(false)
  // The plate's ground and fold are the block's own rules, not the screen's.
  expect(getComputedStyle(plate!).borderRadius).not.toBe(getComputedStyle(bare!).borderRadius)
  expect(getComputedStyle(plate!).whiteSpace).toBe('pre-wrap')
  expect(getComputedStyle(bare!).whiteSpace).toBe('pre')
})

it('sets a line mark in its label\'s role, one of that label\'s lines tall, the mark centred in it', () => {
  act(() => root.render(<><TextMark><svg /></TextMark><TextMark role="value"><svg /></TextMark></>))
  const [nav, value] = [...container.querySelectorAll<HTMLElement>('[data-mark]')]
  expect(nav?.dataset['role']).toBe('navigation')
  expect(value?.dataset['role']).toBe('value')
  // The strut is what makes the box a line tall; the centring puts the mark on it.
  expect(nav?.firstChild?.textContent).toBe('\u200b')
  expect(nav?.className).toContain('items-center')
  expect(nav?.getAttribute('aria-hidden')).toBe('true')
})

it('sets a sentence at the reading size without the tabular figures a value lines up by', () => {
  act(() => root.render(<><Text role="prose">A reason, in words.</Text><Text role="value">12</Text></>))
  const [prose, value] = [...container.querySelectorAll<HTMLElement>('[data-slot="text"]')]
  expect(prose?.dataset['role']).toBe('prose')
  // The same step and weight as a value…
  for (const step of ['text-base', 'leading-(--hd-line)', 'font-normal']) {
    expect(prose?.className).toContain(step)
    expect(value?.className).toContain(step)
  }
  // …and only the value's figures are tabular.
  expect(prose?.className).not.toContain('tabular-nums')
  expect(value?.className).toContain('tabular-nums')
})
