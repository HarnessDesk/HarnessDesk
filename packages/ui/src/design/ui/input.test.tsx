import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { Input } from './input'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
test('name and path measures use their semantic width without leaking a native attribute', async () => {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<><Input measure="name" aria-label="Name" /><Input measure="path" aria-label="Path" /></>))
    for (const [index, measure] of ['name', 'path'].entries()) {
      const input = host.querySelectorAll('input')[index]!
      expect(input.className).toContain(`w-(--hd-field-${measure}-width)`)
      expect(input.hasAttribute('measure')).toBe(false)
    }
  } finally { await act(async () => root.unmount()); host.remove() }
})
