import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ToolSection } from '../design'
import { focusWhenDrawn } from './focus-when-drawn'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()); vi.useRealTimers() })

it('a row hidden by something other than a fold ends the look at once, as before (#2187)', () => {
  vi.useFakeTimers()
  const page = document.createElement('div'); page.hidden = true
  page.innerHTML = '<button data-row="r1">Row</button>'
  const landing = document.createElement('button'); landing.dataset.landing = ''
  document.body.append(page, landing); clean.push(() => { page.remove(); landing.remove() })
  const shown = vi.fn()
  focusWhenDrawn('[data-row="r1"]', shown, { fallback: ['[data-landing]'] })
  expect(shown, 'nothing unfolds a kept-alive page, so the look does not wait for one').toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(5_000)
  expect(document.activeElement, 'and no late landing takes focus after the wait').not.toBe(landing)
})

it('a row inside a folded card unfolds the card and is focused once it is shown (#2187)', async () => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box)
  await act(async () => root.render(<ToolSection label="Work" fold defaultOpen={false}><button data-row="r1">Row</button></ToolSection>))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  const row = box.querySelector<HTMLElement>('[data-row="r1"]')!
  expect(row.closest('[hidden]')).not.toBeNull()
  const shown = vi.fn()
  await act(async () => { focusWhenDrawn('[data-row="r1"]', shown) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(row.closest('[hidden]')).toBeNull()
  expect(shown).toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(row)
})
