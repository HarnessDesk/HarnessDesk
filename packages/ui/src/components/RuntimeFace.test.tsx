import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { runtimeId, type Account, type AccountStatus, type RuntimeInfo } from '@harnessdesk/protocol'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { RuntimeFace } from './RuntimeFace'

const one = { id: runtimeId('alpha'), name: 'Alpha', presentation: { name: 'Alpha' } } as RuntimeInfo
const two = { ...one, id: runtimeId('alpha-other'), slot: { agent: one.id } } as RuntimeInfo
const status = (label: string) => ({ accounts: [{ kind: 'oauth', label }], signInMethods: [] }) satisfies AccountStatus
const snapshot = { ...emptySnapshot(), runtimes: [one, two], accountsByRuntime: { [one.id]: status('alice@example.com'), [two.id]: status('amy@example.com') } }
const store = { getSnapshot: () => snapshot, subscribe: () => () => {} } as unknown as AppStore

it('names an anonymous account without a label after its agent', () => {
  const anonymous = { kind: 'oauth', anonymous: true } as Account
  const anonymousSnapshot = { ...emptySnapshot(), runtimes: [one], accountsByRuntime: { [one.id]: { accounts: [anonymous], signInMethods: [] } } }
  const anonymousStore = { getSnapshot: () => anonymousSnapshot, subscribe: () => () => {} } as unknown as AppStore
  const markup = renderToStaticMarkup(<StoreProvider store={anonymousStore}><RuntimeFace runtime={one} size="sm" /></StoreProvider>)
  expect(markup).toContain('title="Alpha · Alpha"')
})

it('qualifies a 24px runtime face with the account initial', () => {
  const markup = renderToStaticMarkup(<StoreProvider store={store}><RuntimeFace runtime={two} size="sm" /></StoreProvider>)
  expect(markup).toContain('data-slot="face-badge"')
  expect(markup).toContain('>AM</span>')
  expect(markup).toContain('amy@example.com')
  expect(markup).toContain('data-shape="face"')
})

it('keeps smaller runtime faces tinted and named, with no initial badge', () => {
  for (const size of ['navigation', 'stack', 'xs'] as const) {
    const markup = renderToStaticMarkup(<StoreProvider store={store}><RuntimeFace runtime={two} size={size} /></StoreProvider>)
    expect(markup).not.toContain('data-slot="face-badge"')
    expect(markup).toContain('data-tint')
    expect(markup).toContain('amy@example.com')
  }
})
