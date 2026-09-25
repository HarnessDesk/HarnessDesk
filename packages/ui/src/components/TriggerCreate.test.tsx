import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  DEFAULT_TRIGGER_BUDGET, type AuthoringDocument, type AuthoringSavePreview, type HostMethodName, type TriggerDefinition,
} from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { TriggerCreate } from './TriggerCreate'

/**
 * Every time: composing a disarmed trigger. Saving is `authoring/save/*`
 * alone — never `trigger/arm` or the machine's own trigger preferences — and
 * a document the host cannot read yet refuses rather than losing whatever it
 * could not parse.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const DRAFT = (id: string, on: TriggerDefinition['on']): TriggerDefinition => ({
  id, on, opens: { flow: 'review-pr' }, goal: ['pr'], again: null, dedupe: ['pr', 'head', 'event'], concurrency: 1, forks: 'never', budget: DEFAULT_TRIGGER_BUDGET,
})

const EMPTY_DOC: AuthoringDocument = {
  target: { kind: 'triggers', origin: 'project', root: '/repo' }, source: '', digest: '', exists: false, displayPath: '.harnessdesk/triggers.yml', writable: true, issues: [],
}

const fakeHost = (store: AppStore, overrides: Partial<Record<HostMethodName, (params: unknown) => unknown>> = {}) =>
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (overrides[method]) return overrides[method]!(params)
    if (method === 'authoring/read') return EMPTY_DOC
    if (method === 'authoring/triggers/draft') {
      const { id, on } = params as { id: string; on: TriggerDefinition['on'] extends never ? never : 'pull-request' | 'issue' | 'schedule' }
      return DRAFT(id, on === 'schedule' ? { kind: 'schedule', events: ['tick'], everyMinutes: 60 } : on === 'issue' ? { kind: 'issue', events: ['labelled', 'closed', 'commented'] } : { kind: 'pull-request', events: ['opened', 'pushed'] })
    }
    if (method === 'authoring/triggers/render') {
      const { definitions } = params as { definitions: readonly TriggerDefinition[] }
      return { source: JSON.stringify(definitions), issues: [] }
    }
    if (method === 'authoring/save/preview') {
      return { token: 'tok-1', edits: [{ path: '.harnessdesk/triggers.yml', before: null, after: (params as { source: string }).source }], issues: [], resuming: false } satisfies AuthoringSavePreview
    }
    if (method === 'authoring/save/apply') return { state: 'applied', written: ['.harnessdesk/triggers.yml'], message: 'Saved.' }
    return null
  }) as never)

const render = (store: AppStore, opens: TriggerDefinition['opens'] = { flow: 'review-pr' }) => {
  const onSaved = vi.fn()
  const onClose = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <TriggerCreate root="/repo" opens={opens} onSaved={onSaved} onClose={onClose} />
      </StoreProvider>,
    )
  })
  return { onSaved, onClose }
}

const settle = () => act(async () => {})
const button = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button “${label}”`)
  return found
}

it('saving a trigger calls only authoring/save/preview and authoring/save/apply — never trigger/arm or a machine preference', async () => {
  const store = new AppStore('ws://localhost:0/')
  const spy = fakeHost(store)
  const { onSaved } = render(store)
  await settle()

  act(() => button('Save').click())
  await settle()

  expect(onSaved).toHaveBeenCalledWith('review-pr')
  const methods = spy.mock.calls.map((call) => call[0])
  expect(methods).not.toContain('trigger/arm')
  expect(methods).not.toContain('trigger/preferences/set')
  expect(methods).toContain('authoring/save/preview')
  expect(methods).toContain('authoring/save/apply')
  // After saving, the dialog says exactly what did and did not happen.
  expect(document.body.textContent).toContain('Commit this file before arming')
})

it('an existing malformed triggers file refuses an addition rather than risk losing what it could not read', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store, {
    'authoring/read': () => ({
      ...EMPTY_DOC, exists: true, source: 'garbage', issues: [{ at: 'file', text: 'This is not a list.', fix: 'Fix the file by hand.' }],
    }),
  })
  render(store)
  await settle()

  expect(document.body.textContent).toContain('cannot take an addition yet')
  expect(document.body.textContent).toContain('This is not a list.')
  expect([...document.body.querySelectorAll('button')].some((one) => one.textContent?.trim() === 'Save')).toBe(false)
})

it('a changed document since it was read is shown as an issue, and the drafted trigger is not silently lost', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store, {
    'authoring/save/preview': () => ({ token: null, edits: [], issues: [{ at: 'file', text: 'The file changed. Reload before saving.', fix: 'Reload, then try again.' }], resuming: false }),
  })
  render(store)
  await settle()

  expect(document.body.textContent).toContain('The file changed. Reload before saving.')
  expect(button('Save').hasAttribute('disabled')).toBe(true)
  // The drafted trigger's own fields are still on screen, not discarded.
  expect(document.body.textContent).toContain('review-pr')
})

it('the plain path never reads a triggers file — this dialog only mounts on an explicit Every time action', async () => {
  const store = new AppStore('ws://localhost:0/')
  const spy = vi.spyOn(store.transport, 'request')
  act(() => {
    root.render(<StoreProvider store={store}><div /></StoreProvider>)
  })
  await settle()
  expect(spy.mock.calls.filter((call) => call[0] === 'authoring/read')).toHaveLength(0)
})
