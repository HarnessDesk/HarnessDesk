import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ReleaseStills } from './release-stills'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('the clip rig answers real plugin switches and reads a public skill definition', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes(name))!
  try {
    window.history.replaceState(null, '', '/?release-stills=plugin-permissions&site-clip')
    await act(async () => root.render(<ReleaseStills />))
    await act(async () => button('Project docs').click())
    const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"][aria-label$="Project docs"]')!
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    await act(async () => toggle().click())
    expect(toggle().getAttribute('aria-checked')).toBe('false')
    await act(async () => toggle().click())
    expect(toggle().getAttribute('aria-checked')).toBe('true')
    await act(async () => root.render(null))
    window.history.replaceState(null, '', '/?release-stills=library&site-clip')
    await act(async () => root.render(<ReleaseStills />))
    await act(async () => button('Matrix').click())
    await act(async () => button('code-review').click())
    await act(async () => button('Read the definition').click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Correctness first')
    expect(dialog.textContent).not.toContain('/home/')
  } finally {
    act(() => root.unmount())
    host.remove()
    window.history.replaceState(null, '', '/')
  }
})
