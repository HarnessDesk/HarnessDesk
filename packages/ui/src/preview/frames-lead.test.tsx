import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore } from './harness'
import { LeadFrame } from './frames-lead'
import { LEAD_SCENES } from './lead-fixture'

it.each(LEAD_SCENES.flatMap(scene => (['light', 'dark'] as const).map(theme => ({ scene, theme }))))('renders $scene in $theme with a synthetic window facade', async ({ scene, theme }) => {
  const url = window.location.href
  window.history.replaceState(null, '', `?lead-synthetic=${scene}&theme=${theme}`)
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={previewStore({ theme: 'light' })}><LeadFrame scene={scene} /></StoreProvider>))
    expect(box.querySelector(`[data-frame-id="lead-${scene}"]`)).not.toBeNull()
    expect(box.querySelector('h1')?.textContent).toBe('Lead')
    expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(theme === 'dark')
  } finally { act(() => root.unmount()); box.remove(); window.history.replaceState(null, '', url); document.body.removeAttribute('data-hd-dark-theme') }
})
