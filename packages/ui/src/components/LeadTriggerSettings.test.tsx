import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { previewStore } from '../preview/harness'
const modules = import.meta.glob('./LeadTriggerSettings.tsx', { eager: true }) as Record<string, { LeadTriggerSettings: React.ComponentType<any> }>
const LeadTriggerSettings = modules['./LeadTriggerSettings.tsx']?.LeadTriggerSettings ?? (() => null)
const clean: (() => void)[] = []
afterEach(() => clean.splice(0).forEach(fn => fn()))
const mount = async (follow?: { checks: boolean; reviews: boolean }) => {
  const store = previewStore(), box = document.createElement('div'), root = createRoot(box), update = vi.fn(async () => {}), openFile = vi.fn()
  document.body.append(box)
  const projectTriggers = vi.fn(async () => ({ path: '/workspace/demo/.harnessdesk/triggers.yml', triggers: [
    { id: 'lead', definition: { opens: { lead: true } } }, { id: 'flow', definition: { opens: { flow: 'review' } } }] }))
  const previewTrigger = vi.fn(async () => ({ lead: { summary: 'Checks failed on acme/widgets' } }))
  Object.assign(store, { projectTriggers, previewTrigger, openFile })
  const render = async (next = follow) => act(async () => root.render(<StoreProvider store={store}><LeadTriggerSettings follow={next} root="/workspace/demo" update={update} onError={vi.fn()} /></StoreProvider>))
  await render(); clean.push(() => { act(() => root.unmount()); box.remove() })
  return { box, update, render, openFile, previewTrigger }
}
it('defaults both follows on, persists each independently and reflects server settings', async () => {
  const { box, update, render } = await mount()
  const switches = () => [...box.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
  expect(switches().map(node => node.getAttribute('aria-checked'))).toEqual(['true', 'true'])
  await act(async () => switches()[0]!.click())
  expect(update).toHaveBeenLastCalledWith({ follow: { checks: false, reviews: true } })
  await render({ checks: false, reviews: true })
  await act(async () => switches()[1]!.click())
  expect(update).toHaveBeenLastCalledWith({ follow: { checks: false, reviews: false } })
  await render({ checks: true, reviews: false })
  expect(switches().map(node => node.getAttribute('aria-checked'))).toEqual(['true', 'false'])
})
it('lists only Lead targets with preview summaries and opens the returned file without arm or edit controls', async () => {
  const { box, openFile, previewTrigger } = await mount()
  expect(previewTrigger).toHaveBeenCalledTimes(1)
  expect(previewTrigger).toHaveBeenCalledWith('/workspace/demo', 'lead')
  const row = [...box.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Checks failed on acme/widgets'))!
  expect(row).toBeDefined()
  await act(async () => row.click())
  expect(openFile).toHaveBeenCalledWith('/workspace/demo/.harnessdesk/triggers.yml')
  expect(box.textContent).not.toMatch(/Slack|Arm|Save|flow/)
})
