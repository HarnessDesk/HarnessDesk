import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentItem, FileChangeItem } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { ItemView } from './Items'

/**
 * The `+N −M` beside a changed file, read off the rendered row.
 *
 * `countDrawn` is tested on its own in `lib/diff.test.ts`. What this pins is
 * that the row asks it the question the view under it answers: an added file
 * that arrives as its content is drawn as all additions, so its counts have
 * no removals, whatever its lines start with. Review of #133 found the row
 * still counting such a file by the diff rule, where a YAML front-matter
 * `---` read as a removed line.
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

// useSyncExternalStore compares snapshots by identity, so this has to be the
// same object every read or the render never settles.
const snapshot = emptySnapshot()

const show = (changes: FileChangeItem['changes']): void => {
  const store = { subscribe: () => () => {}, getSnapshot: () => snapshot } as unknown as AppStore
  const item = { id: 'f1', type: 'fileChange', status: 'completed', changes } as unknown as AgentItem
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ItemView item={item} root="/w" />
      </StoreProvider>,
    )
  })
}

const texts = (tone: string): string[] =>
  [...container.querySelectorAll(`[data-slot="change-stats"] [data-tone="${tone}"]`)].map((el) => el.textContent ?? '')

describe('the counts beside a changed file', () => {
  it('an added file that arrives as its content has no removals, front matter and all', () => {
    show([{ path: '/w/posts/hello.md', kind: { type: 'add' }, diff: '---\ntitle: Hello\n---\nBody\n' }])
    expect(texts('success')).toEqual(['+4'])
    expect(texts('danger')).toEqual(['−0'])
    expect(container.textContent?.match(/hello\.md/g)).toHaveLength(1)
  })

  it('an added file that arrives as a real diff is counted as one', () => {
    show([
      { path: '/w/a.txt', kind: { type: 'add' }, diff: '--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n' },
    ])
    expect(texts('success')).toEqual(['+2'])
    expect(texts('danger')).toEqual(['−0'])
    expect(container.textContent).not.toContain('Hunk 1 of')
  })

  it('an added file whose text contains @@ is still counted as its content', () => {
    show([{ path: '/w/notes.md', kind: { type: 'add' }, diff: 'ping @@ops\n- item one\n' }])
    expect(texts('success')).toEqual(['+2'])
    expect(texts('danger')).toEqual(['−0'])
  })

  it('a deleted file that arrives as its content counts its lines as removed', () => {
    show([{ path: '/w/old.md', kind: { type: 'delete' }, diff: '# Old\n\n- gone\n' }])
    expect(texts('success')).toEqual(['+0'])
    expect(texts('danger')).toEqual(['−3'])
    // And drawn as what it counts: three removal rows, no additions.
    expect(container.querySelectorAll('tr[class*="_remove_"]')).toHaveLength(3)
    expect(container.querySelectorAll('tr[class*="_add_"]')).toHaveLength(0)
  })

  it('a modified file is counted by the diff rule, a removed --- included', () => {
    show([{ path: '/w/b.md', kind: { type: 'update' }, diff: '@@ -1,2 +1,2 @@\n----\n+title\n same\n' }])
    expect(texts('success')).toEqual(['+1'])
    expect(texts('danger')).toEqual(['−1'])
  })

  it('keeps one compact file header per file when a step changes several', () => {
    show([
      { path: '/w/src/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' },
      { path: '/w/src/b.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' },
    ])
    act(() => container.querySelector<HTMLButtonElement>('button')?.click())

    expect(container.textContent).toContain('src/a.ts')
    expect(container.textContent).toContain('src/b.ts')
    expect(container.querySelectorAll('[class*="_fileHeader_"]')).toHaveLength(2)
  })
})
