import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore } from './harness'
import { LeadSettingsSection } from '../components/LeadSettings'
import { LeadFrame, createLeadFixtureStore } from './frames-lead'
import { LEAD_SCENES } from './lead-fixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it.each(LEAD_SCENES.filter(scene => scene !== 'app-shell').flatMap(scene => (['light', 'dark'] as const).map(theme => ({ scene, theme }))))('renders $scene in $theme with a synthetic window facade', async ({ scene, theme }) => {
  const url = window.location.href
  window.history.replaceState(null, '', `?lead-synthetic=${scene}&theme=${theme}`)
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={previewStore({ theme: 'light' })}><LeadFrame scene={scene} /></StoreProvider>))
    expect(box.querySelector(`[data-frame-id="lead-${scene}"]`)).not.toBeNull()
    if (scene.startsWith('settings-')) expect(box.textContent).toContain('Provider key')
    else expect(box.querySelector('[data-slot="conversation-shell"]')).not.toBeNull()
    expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(theme === 'dark')
  } finally { act(() => root.unmount()); box.remove(); window.history.replaceState(null, '', url); document.body.removeAttribute('data-hd-dark-theme') }
})

it.each(['light', 'dark'])('shows the selected Lead in the enabled app shell in %s', async theme => {
  const url = window.location.href; window.history.replaceState(null, '', `?theme=${theme}`)
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={previewStore()}><LeadFrame scene="app-shell" /></StoreProvider>))
    expect(box.querySelector('[data-page-destination="lead"] [data-slot="conversation-shell"]')).not.toBeNull()
    expect(box.querySelector('button[title="Lead"][aria-current="page"]')).not.toBeNull()
    expect(box.querySelector('[data-slot="top-bar"]')).not.toBeNull()
    expect(document.body.hasAttribute('data-hd-dark-theme')).toBe(theme === 'dark')
  } finally { act(() => root.unmount()); box.remove(); window.history.replaceState(null, '', url); document.body.removeAttribute('data-hd-dark-theme') }
}, 30000)

it('retains an added permission rule when the synthetic settings specimen reopens', async () => {
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  const store = createLeadFixtureStore('settings-configured')
  const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === name)!
  try {
    await act(async () => root.render(<StoreProvider store={store}><LeadSettingsSection /></StoreProvider>))
    await act(async () => button('Add rule').click()); await act(async () => button('Save permissions').click())
    expect(button('Save permissions').disabled).toBe(true)
    await act(async () => root.render(null)); await act(async () => root.render(<StoreProvider store={store}><LeadSettingsSection /></StoreProvider>))
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Rule 1 effect"]')?.value).toBe('ask')
    expect(document.querySelector<HTMLSelectElement>('[aria-label="Rule 1 method"]')?.value).toBe('flow/start-goal')
  } finally { act(() => root.unmount()); box.remove() }
})

it.each(['light', 'dark'])('previews loading without a name and pending-plan notice spacing in %s', async theme => {
  const url = window.location.href; window.history.replaceState(null, '', `?theme=${theme}`)
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={previewStore()}><LeadFrame scene="loading" /></StoreProvider>))
    expect(box.textContent).toContain('Hi, tell me what you want done.')
    await act(async () => root.render(<StoreProvider store={previewStore()}><LeadFrame scene="pending-plan" /></StoreProvider>))
    const notices = box.querySelector('[data-slot="composer-notices"]')!
    expect(notices.textContent).toContain('Review plan')
    expect(notices.querySelector('[data-lead-decision]')).not.toBeNull()
  } finally { act(() => root.unmount()); box.remove(); window.history.replaceState(null, '', url); document.body.removeAttribute('data-hd-dark-theme') }
})
