import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
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
