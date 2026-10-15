import { expect, it } from 'vitest'
import { DEFAULT_DIFF_PREFS, readDiffPrefs } from './diff-prefs'

it('starts old or missing preference blobs at the approved defaults', () => {
  for (const value of [undefined, null, [], 'bad', { wrap: 'false', highlightWords: 0, hideWhitespace: 1 }]) {
    expect(readDiffPrefs(value)).toEqual(DEFAULT_DIFF_PREFS)
  }
})
it('reads each saved boolean while filling fields absent from an older version', () => {
  expect(readDiffPrefs({ wrap: false, hideWhitespace: true, groupByFolder: true, unrelated: true })).toEqual({
    ...DEFAULT_DIFF_PREFS, wrap: false, hideWhitespace: true, groupByFolder: true,
  })
})
