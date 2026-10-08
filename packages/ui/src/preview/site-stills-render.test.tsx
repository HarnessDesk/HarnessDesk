import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { FlowStart } from '../components/FlowStart'
import { StoreProvider } from '../state/context'
import { SiteStills, siteStillStore } from './site-stills'
import { siteStartPreview } from './site-stills-data'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('the compact start excerpt keeps the production Brief input and every Seat candidate', async () => {
  const store = siteStillStore('start-preview')
  store.previewFlow = async () => siteStartPreview()
  const camera = document.createElement('div')
  const production = document.createElement('div')
  document.body.append(camera, production)
  const cameraRoot = createRoot(camera)
  const productionRoot = createRoot(production)
  try {
    const initial = { source: 'frozen website Flow', vars: {
      brief: 'Bound the retry attempts and keep the final failure visible.', task: 'Retry the checkout call on a 502',
    } }
    await act(async () => {
      cameraRoot.render(<StoreProvider store={store}><SiteStills scene="start-preview" /></StoreProvider>)
      productionRoot.render(<StoreProvider store={store}><FlowStart root="/work/storefront" initial={initial} onChange={() => {}} /></StoreProvider>)
    })
    expect(camera.textContent).toContain('Attach a file…')
    const brief = camera.querySelector('textarea')!
    const productionBrief = production.querySelector('textarea')!
    expect(brief.rows).toBe(productionBrief.rows)
    expect(brief.value).toBe(productionBrief.value)
    expect(camera.querySelector('input:not([type="file"])')!.getAttribute('value')).toBe(initial.vars.task)
    const summary = camera.querySelector('[aria-label="Seats this would open"]')!
    const productionSummary = production.querySelector('[aria-label="Seats this would open"]')!
    expect(summary.textContent).toBe(productionSummary.textContent)
    expect(summary.querySelectorAll('[data-slot="row"]')).toHaveLength(6)
    expect(summary.textContent).toContain('Implementer — write, isolated')
    expect(summary.textContent).toContain('Code reviewer — review, isolated')
    expect(summary.textContent).toContain('Picked')
    const start = [...camera.querySelectorAll('button')].find(button => button.textContent === 'Start')
    expect(start).toBeTruthy()
    expect(start!.disabled).toBe(false)
  } finally {
    act(() => { cameraRoot.unmount(); productionRoot.unmount() })
    camera.remove()
    production.remove()
  }
})
