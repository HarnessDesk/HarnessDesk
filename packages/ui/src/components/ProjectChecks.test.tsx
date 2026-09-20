import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { PREVIEW_CHECKS } from '../preview/evidence-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ProjectChecks } from './ProjectChecks'

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

const ROOT = '/home/dev/code/HarnessDesk'

const mount = async (projectChecks: (root: string) => Promise<unknown>) => {
  const snapshot = { ...emptySnapshot(), status: 'open', home: '/home/dev' } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    projectChecks: vi.fn(projectChecks),
  } as unknown as AppStore
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <ProjectChecks root={ROOT} />
      </StoreProvider>,
    )
  })
  await act(async () => {})
  return store
}

it('lists each check with its command verbatim, whether this Mac has approved it, and the file and commit it is read from', async () => {
  const checks = {
    ...PREVIEW_CHECKS,
    project: ROOT,
    file: `${ROOT}/.harnessdesk/checks.yml`,
  }
  const store = await mount(async () => checks)
  expect(store.projectChecks).toHaveBeenCalledWith(ROOT)
  const text = container.textContent ?? ''
  expect(text).toContain('Read from ~/code/HarnessDesk/.harnessdesk/checks.yml, as committed at a1b2c3d.')
  expect([...container.querySelectorAll('code, [class*="mono"]')].map((one) => one.textContent)).toEqual([
    'pnpm verify',
    'pnpm lint --max-warnings 0',
    'pnpm typecheck',
  ])
  expect(text).toContain('Approved on this Mac')
  expect(text).toContain('Changed since approved here')
  expect(text).toContain('Not approved on this Mac')
  expect(text).not.toContain('Your working copy')
})

it('a working copy that is not what is committed is said, and what is listed is still the committed file', async () => {
  await mount(async () => ({ ...PREVIEW_CHECKS, uncommitted: true }))
  const text = container.textContent ?? ''
  expect(text).toContain('Your working copy of this file is not what is committed.')
  expect(text).toContain('pnpm verify')
})

it('a check the file refuses is listed with where and why, never hidden', async () => {
  await mount(async () => PREVIEW_CHECKS)
  const text = container.textContent ?? ''
  expect(text).toContain('e2e.run')
  expect(text).toContain('not plain printable ASCII')
  expect(text).toContain('Not offered')
})

it('a project with no checks file shows no section at all', async () => {
  await mount(async () => ({ ...PREVIEW_CHECKS, exists: false, checks: [], problems: [] }))
  expect(container.innerHTML).toBe('')
})

it('checks that cannot be read say so, in the host’s words', async () => {
  await mount(async () => {
    throw new Error('/home/dev/elsewhere is outside every open workspace. Open its folder first.')
  })
  expect(container.textContent).toContain('Its checks could not be read')
  expect(container.textContent).toContain('is outside every open workspace')
})
