import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ToolBody, ToolFold, ToolSection } from './ToolBody'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove() })

const card = (label: string) => container.querySelector<HTMLElement>(`[data-slot="tool-section"][aria-label="${label}"]`)!

it('draws each section as a card with its summary in the header', () => {
  act(() => root.render(<ToolBody><ToolSection label="Seats" value={2}><p>AlphaWorking</p></ToolSection></ToolBody>))
  expect(card('Seats').className).toContain('rounded-(--hd-panel-card-radius)')
  expect(card('Seats').querySelector('[data-slot="tool-section-value"]')?.textContent).toBe('2')
  expect(card('Seats').querySelector('p')?.textContent).toBe('AlphaWorking')
})

it('a folding card keeps its value while folded and opens from its header', () => {
  act(() => root.render(<ToolSection label="Board" value="2 open" fold defaultOpen={false}><p>#4 Retry</p></ToolSection>))
  const toggle = card('Board').querySelector<HTMLButtonElement>('[data-slot="tool-section-fold"]')!
  const body = card('Board').querySelector<HTMLElement>('[data-slot="tool-section-body"]')!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(body.hidden).toBe(true)
  expect(card('Board').hasAttribute('data-folded')).toBe(true)
  expect(card('Board').querySelector('[data-slot="tool-section-value"]')?.textContent).toBe('2 open')
  act(() => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(body.hidden).toBe(false)
  expect(toggle.getAttribute('aria-controls')).toBe(body.id)
})

it('a card that does not fold has no disclosure', () => {
  act(() => root.render(<ToolSection label="Run" value="Running">Facts</ToolSection>))
  expect(card('Run').querySelector('[data-slot="tool-section-fold"]')).toBeNull()
  expect(card('Run').hasAttribute('data-folded')).toBe(false)
})

it('the fold line hides the rest until asked', () => {
  act(() => root.render(<ToolSection label="Run">
    <ToolFold label="All facts"><p>Rounds 2</p></ToolFold>
  </ToolSection>))
  const fold = container.querySelector<HTMLButtonElement>('[data-slot="tool-fold"] button')!
  expect(container.textContent).not.toContain('Rounds 2')
  act(() => fold.click())
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  expect(container.textContent).toContain('Rounds 2')
})


it('uses the summary as part of the disclosure target while keeping title actions independent', () => {
  const action = vi.fn()
  act(() => root.render(<ToolSection label="Background tasks" value="2 running" fold action={<button onClick={action}>Clear</button>}><input aria-label="Task filter" defaultValue="watch" /></ToolSection>))
  const section = card('Background tasks')
  const toggle = section.querySelector<HTMLButtonElement>('[data-slot="tool-section-fold"]')!
  const summary = section.querySelector<HTMLElement>('[data-slot="tool-section-value"]')!
  expect(toggle.contains(summary)).toBe(true)
  act(() => summary.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(section.querySelector<HTMLElement>('[data-slot="tool-section-body"]')!.hidden).toBe(true)
  const clear = [...section.querySelectorAll('button')].find(one => one.textContent === 'Clear')!
  expect(toggle.contains(clear)).toBe(false)
  act(() => clear.click())
  expect(action).toHaveBeenCalledOnce()
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  act(() => toggle.click())
  expect(section.querySelector<HTMLInputElement>('input')!.value).toBe('watch')
})


it('keeps long labels and summaries named while the disclosure and independent action can shrink in a narrow header', () => {
  const label = `Selected ${'step'.repeat(200)}`, value = 'revision'.repeat(200)
  act(() => root.render(<ToolSection label={label} value={value} fold action={<button aria-label="Record actions">More</button>}>Facts</ToolSection>))
  const section = card(label)
  const toggle = section.querySelector<HTMLButtonElement>('[data-slot="tool-section-fold"]')!
  expect(toggle.getAttribute('aria-label')).toBe(label)
  const summary = section.querySelector<HTMLElement>('[data-slot="tool-section-value"]')!
  expect(toggle.getAttribute('aria-describedby')).toBe(summary.id)
  expect(summary.title).toBe(value)
  expect(summary.className).toContain('min-w-0')
  expect(summary.className).toContain('truncate')
  expect(section.querySelector('[data-slot="tool-section-actions"]')?.className).toContain('shrink-0')
  toggle.focus()
  act(() => toggle.click())
  expect(document.activeElement).toBe(toggle)
  expect(toggle.type).toBe('button')
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
})
