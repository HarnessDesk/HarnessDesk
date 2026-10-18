import { installTopBarTestLayout } from '../test/top-bar-layout'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { ReadmeRace } from './readme-race'
import { ReleaseStills } from './release-stills'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
installTopBarTestLayout()

const mount = async (search: string, node: () => React.ReactNode) => {
  window.history.replaceState(null, '', `/${search}`)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(node()))
  return { container, done: () => { act(() => root.unmount()); container.remove(); window.history.replaceState(null, '', '/') } }
}

it('races two Seats Side by side and reaches the judge’s pick', async () => {
  const { container, done } = await mount('?readme-race', () => <ReadmeRace />)
  try {
    expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(2)
    expect(container.textContent).not.toContain('Picked')
    await act(async () => { window.dispatchEvent(new CustomEvent('readme-race-stage', { detail: 3 })) })
    expect(container.textContent).toContain('Picked')
    expect(container.querySelectorAll('[data-slot="side-by-side-tile"]')).toHaveLength(2)
  } finally { done() }
})

it('names the preview’s runtimes after the shipped agents under ?readme-names', async () => {
  const { container, done } = await mount('?release-stills=dash-agents&readme-names', () => <ReleaseStills />)
  try {
    for (const name of ['Codex', 'Claude Code', 'Cursor']) expect(container.textContent).toContain(name)
    for (const name of ['Alpha', 'Beta', 'Gamma']) expect(container.textContent).not.toContain(name)
  } finally { done() }
})
