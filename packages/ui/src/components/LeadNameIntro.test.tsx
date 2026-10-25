import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LeadNameIntro } from './LeadNameIntro'

it.each(['Dex', 'Lex', 'Keep'])('offers a chip on the Lead line and hides it after %s', label => {
  const box = document.createElement('div'), root = createRoot(box), choose = vi.fn()
  act(() => root.render(<LeadNameIntro name="dex" chosen={false} pending={false} onChoose={choose} />))
  expect(box.querySelector('[data-slot="chip"]')).not.toBeNull()
  act(() => [...box.querySelectorAll('button')].find(button => button.textContent === label)!.click())
  expect(choose).toHaveBeenCalledExactlyOnceWith(label === 'Lex' ? 'lex' : 'dex')
  act(() => root.render(<LeadNameIntro name="dex" chosen pending={false} onChoose={choose} />))
  expect(box.textContent).toBe('')
  act(() => root.unmount())
})
