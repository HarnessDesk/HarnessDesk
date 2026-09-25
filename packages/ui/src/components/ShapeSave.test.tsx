import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AuthoringSaveInput, AuthoringSavePreview, HostMethodName } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { ShapeSave } from './ShapeSave'

/**
 * Saving a shape: scope and name are editable, previewed against the host
 * before anything writes, and a dependency refusal — a project-only Agent a
 * user-scope save cannot use — is a visible banner, never a silently
 * substituted Agent or a save that proceeds anyway.
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

const INPUT: AuthoringSaveInput = {
  target: { kind: 'flow', origin: 'project', id: 'my-shape', root: '/repo' },
  expected: null,
  source: 'version: 2\nname: Mine\n',
}

const requestSpy = (handlers: Partial<Record<HostMethodName, (params: unknown) => unknown>>) => {
  const store = new AppStore('ws://localhost:0/')
  const spy = vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    const handler = handlers[method]
    if (handler) return handler(params)
    return null
  }) as never)
  return { store, spy }
}

const render = (store: AppStore, input: AuthoringSaveInput = INPUT) => {
  const onSaved = vi.fn()
  const onClose = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ShapeSave input={input} onSaved={onSaved} onClose={onClose} />
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
const rowFor = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.startsWith(label))
  if (!found) throw new Error(`no row “${label}”`)
  return found
}

it('the changed file’s path reads in the interface’s own face — a name, never mono', async () => {
  const { store } = requestSpy({
    'authoring/save/preview': (): AuthoringSavePreview => (
      { token: 'tok', edits: [{ path: '.harnessdesk/flows/my-shape.yml', before: null, after: INPUT.source }], issues: [], resuming: false }
    ),
  })

  render(store)
  await settle()

  expect(document.body.textContent).toContain('.harnessdesk/flows/my-shape.yml')
  expect(document.body.querySelector('[data-slot="code-text"]')).toBeNull()
})

it('a project-only dependency refuses a user-scope save visibly, with no silent fallback Agent', async () => {
  const { store } = requestSpy({
    'authoring/save/preview': (params): AuthoringSavePreview => {
      const { target } = params as AuthoringSaveInput
      return target.origin === 'user'
        ? { token: null, edits: [{ path: 'flows/my-shape.yml', before: null, after: INPUT.source }], issues: [{ at: 'roles', text: 'This flow names “reviewer”, which only this project has.', fix: 'Copy these Agents for you first.' }], resuming: false }
        : { token: 'tok', edits: [{ path: '.harnessdesk/flows/my-shape.yml', before: null, after: INPUT.source }], issues: [], resuming: false }
    },
  })

  render(store)
  await settle()
  expect(button('Save').hasAttribute('disabled')).toBe(false)

  act(() => rowFor('For you').click())
  await settle()

  expect(document.body.textContent).toContain('only this project has')
  expect(document.body.textContent).toContain('Copy these Agents for you first.')
  expect(button('Save').hasAttribute('disabled')).toBe(true)
})

it('saving applies the exact previewed token and reports the applied result', async () => {
  const { store, spy } = requestSpy({
    'authoring/save/preview': (): AuthoringSavePreview => ({ token: 'tok-1', edits: [{ path: '.harnessdesk/flows/my-shape.yml', before: null, after: INPUT.source }], issues: [], resuming: false }),
    'authoring/save/apply': (params) => {
      expect((params as { token: string }).token).toBe('tok-1')
      return { state: 'applied', written: ['.harnessdesk/flows/my-shape.yml'], message: 'Saved.' }
    },
  })

  const { onSaved } = render(store)
  await settle()
  act(() => button('Save').click())
  await settle()

  expect(onSaved).toHaveBeenCalledWith({ state: 'applied', written: ['.harnessdesk/flows/my-shape.yml'], message: 'Saved.' })
  const applies = spy.mock.calls.filter((call) => call[0] === 'authoring/save/apply')
  expect(applies).toHaveLength(1)
})
