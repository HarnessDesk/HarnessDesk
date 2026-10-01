import { act } from 'react'
import { useSnapshotSelector, StoreProvider } from './context'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { emptySnapshot, type AppSnapshot, type AppStore } from './store'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

it('re-renders and mutates only the row whose selected value changed', async () => {
  let snapshot = { ...emptySnapshot(), activeSessionKey: null } as AppSnapshot
  const listeners = new Set<() => void>()
  const store = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  } as unknown as AppStore
  const renders = new Map<string, number>()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)

  const Row = ({ id }: { id: string }) => {
    const active = useSnapshotSelector((state) => state.activeSessionKey === id)
    renders.set(id, (renders.get(id) ?? 0) + 1)
    return <button data-active={active || undefined}>{id}</button>
  }
  const render = () => root!.render(<StoreProvider store={store}><Row id="one" /><Row id="two" /></StoreProvider>)
  act(render)
  const one = container.querySelector<HTMLButtonElement>('button')!
  const two = container.querySelectorAll<HTMLButtonElement>('button')[1]!
  const oneMutations: MutationRecord[] = []
  const twoMutations: MutationRecord[] = []
  const observerOne = new MutationObserver((records) => oneMutations.push(...records))
  const observerTwo = new MutationObserver((records) => twoMutations.push(...records))
  observerOne.observe(one, { attributes: true, childList: true, characterData: true, subtree: true })
  observerTwo.observe(two, { attributes: true, childList: true, characterData: true, subtree: true })
  const beforeOne = renders.get('one')
  const beforeTwo = renders.get('two')

  act(() => {
    snapshot = { ...snapshot, activeSessionKey: 'one' as AppSnapshot['activeSessionKey'] }
    listeners.forEach((listener) => listener())
  })
  await act(async () => { await Promise.resolve() })

  expect(renders.get('one')).toBe(beforeOne! + 1)
  expect(renders.get('two')).toBe(beforeTwo)
  expect(one.hasAttribute('data-active')).toBe(true)
  expect(two.hasAttribute('data-active')).toBe(false)
  expect(oneMutations.length).toBeGreaterThan(0)
  expect(twoMutations).toHaveLength(0)
  observerOne.disconnect()
  observerTwo.disconnect()
})
