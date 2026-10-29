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

it.each(['light', 'dark'])('previews loading without a name and pending-plan decision spacing in %s', async theme => {
  const url = window.location.href; window.history.replaceState(null, '', `?theme=${theme}`)
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={previewStore()}><LeadFrame scene="loading" /></StoreProvider>))
    expect(box.textContent).toContain('Hi, what can I help you with?')
    await act(async () => root.render(<StoreProvider store={previewStore()}><LeadFrame scene="pending-plan" /></StoreProvider>))
    const notices = box.querySelector('[data-slot="composer-notices"]')!
    expect(notices.textContent).not.toContain('Review plan')
    expect(notices.textContent).not.toContain('The plan needs your decision')
    expect(notices.textContent).toContain('Approve this plan?')
    expect(notices.querySelector('[data-lead-decision]')).not.toBeNull()
  } finally { act(() => root.unmount()); box.remove(); window.history.replaceState(null, '', url); document.body.removeAttribute('data-hd-dark-theme') }
})


it.each(['light', 'dark'])('previews consent expiry once alongside its decision in %s', async theme => {
  const url = window.location.href; window.history.replaceState(null, '', `?theme=${theme}`)
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={previewStore()}><LeadFrame scene="consent-expired" /></StoreProvider>))
    const notices = box.querySelector('[data-slot="composer-notices"]')!
    expect(notices.textContent?.match(/earlier approval expired at/g)).toHaveLength(1)
    expect(notices.textContent).not.toContain('Review plan')
    expect(notices.textContent).toContain('Approve this plan?')
  } finally { act(() => root.unmount()); box.remove(); window.history.replaceState(null, '', url); document.body.removeAttribute('data-hd-dark-theme') }
})


it.each(['light', 'dark'])('previews a missing plan without an inert action and explains terminal predecessors in %s', async theme => {
  const url = window.location.href; window.history.replaceState(null, '', `?theme=${theme}`)
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={previewStore()}><LeadFrame scene="missing-plan" /></StoreProvider>))
    const notices = box.querySelector('[data-slot="composer-notices"]')!
    expect(notices.textContent).toContain('The plan needs your decision before work continues.')
    expect([...notices.querySelectorAll('button')].filter(node => !node.closest('[data-slot="lead-run-strip"]'))).toEqual([])
    expect(box.querySelector('[data-lead-decision]')).toBeNull()
    await act(async () => root.render(<StoreProvider store={previewStore()}><LeadFrame scene="predecessor-unavailable" /></StoreProvider>))
    expect(box.textContent).toContain("The previous step's result wasn't accepted, so the next step can't start. Message Dex to change the plan, or stop this goal.")
    expect([...box.querySelectorAll('[data-slot="composer-notices"] button')].map(node => node.textContent)).toEqual(['Stop goal'])
    await act(async () => root.render(<StoreProvider store={previewStore()}><LeadFrame scene="predecessor-unverifiable" /></StoreProvider>))
    expect(box.textContent).toContain("HarnessDesk can't confirm what the previous step produced, so the next step won't start. Message Dex to change the plan, or stop this goal.")
    expect([...box.querySelectorAll('[data-slot="composer-notices"] button')].map(node => node.textContent)).toEqual(['Stop goal'])
  } finally { act(() => root.unmount()); box.remove(); window.history.replaceState(null, '', url); document.body.removeAttribute('data-hd-dark-theme') }
})


it.each((['light', 'dark'] as const).flatMap(theme => (['running', 'running-message'] as const).map(scene => ({ theme, scene } as const))))('previews $scene Stop on the run strip, with Send always in the corner, in $theme', async ({ theme, scene }) => {
  const url = window.location.href; window.history.replaceState(null, '', `?theme=${theme}`)
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  try {
    await act(async () => root.render(<StoreProvider store={previewStore()}><LeadFrame scene={scene} /></StoreProvider>))
    expect(box.querySelector('[data-slot="lead-run-strip"]')?.textContent).toContain('Dex is running 1 goal')
    expect([...box.querySelectorAll('[data-slot="lead-run-strip"] button')].map(node => node.textContent)).toEqual(['Stop goal'])
    expect(box.querySelector('[data-slot="top-bar"]')?.textContent).not.toContain('Stop goal')
    expect(box.querySelectorAll('[data-composer-track="send"] button')).toHaveLength(1)
    if (scene === 'running-message') expect(box.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('Also check keyboard focus')
  } finally { act(() => root.unmount()); box.remove(); window.history.replaceState(null, '', url); document.body.removeAttribute('data-hd-dark-theme') }
})

it.each(['light', 'dark'])('previews the one quiet line while the Lead plans, while it works, and after Stop in %s', async theme => {
  const url = window.location.href; window.history.replaceState(null, '', `?theme=${theme}`)
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  const line = () => box.querySelector('[data-slot="lead-live-line"]')
  const frame = (scene: 'planning' | 'running' | 'stopped') => act(async () => root.render(<StoreProvider store={previewStore()}><LeadFrame scene={scene} /></StoreProvider>))
  try {
    await frame('planning')
    expect(line()?.textContent).toBe('Thinking…')
    await frame('running')
    expect(line()?.textContent).toBe('Step 1 of 1 · Implement and review · 1 run')
    // Stop through the synthetic facade: what was reported as running is no longer reported, and the thread says why.
    await act(async () => box.querySelector<HTMLButtonElement>('[data-slot="lead-run-strip"] button')!.click())
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(node => node.textContent === 'Stop goal')!.click())
    await act(async () => {})
    expect(line()?.textContent).toBe('This goal was stopped.')
    expect(box.querySelector('[data-slot="lead-run-strip"]')).toBeNull()
    expect(box.querySelector('[data-composer-track="send"] [aria-busy="true"]')).toBeNull()
    await frame('stopped')
    expect(line()?.textContent).toBe('This goal was stopped.')
    expect(line()?.hasAttribute('data-settled')).toBe(true)
  } finally { act(() => root.unmount()); box.remove(); window.history.replaceState(null, '', url); document.body.removeAttribute('data-hd-dark-theme') }
})
