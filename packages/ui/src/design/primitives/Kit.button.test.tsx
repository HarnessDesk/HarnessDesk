import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Btn } from './Kit'

/**
 * The alias table, checked on the element rather than in the source.
 *
 * `Kit.tsx` maps eight spellings onto four paints — `ghost` is `quiet`,
 * `destructive` is `danger`, `default` is `primary` — because the app carries
 * two button vocabularies and roughly ninety call sites still write the older
 * three. The table is six lines and reads as obviously right, which is why it
 * had no test: it is also the single point of truth for every one of those
 * call sites, and a wrong row would repaint them silently.
 *
 * `secondary` is the row worth naming. It is the base rule, so it deliberately
 * emits **no** attribute at all — writing the word and writing nothing have to
 * paint identically, or the vocabulary is a lie. A future edit that "tidies"
 * it into `data-variant="secondary"` would fall through to no styling, since
 * `Kit.module.css` has no such rule; nothing else in the suite would notice.
 */
describe('Btn speaks one vocabulary', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const paint = (node: React.ReactElement) => {
    act(() => root.render(node))
    return host.querySelector('button')
  }

  it.each([
    ['default', 'primary'],
    ['primary', 'primary'],
    ['outline', 'outline'],
    ['ghost', 'quiet'],
    ['quiet', 'quiet'],
    ['destructive', 'danger'],
    ['danger', 'danger'],
  ] as const)('draws %s as %s', (written, painted) => {
    expect(paint(<Btn variant={written}>Go</Btn>)?.getAttribute('data-variant')).toBe(painted)
  })

  it('says nothing for secondary, which is what an unqualified button says', () => {
    expect(paint(<Btn variant="secondary">Go</Btn>)?.hasAttribute('data-variant')).toBe(false)
    expect(paint(<Btn>Go</Btn>)?.hasAttribute('data-variant')).toBe(false)
  })
})
