import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import * as editor from './index'

// Importing the patch view must not load the file editing engine.
vi.mock('./CodeView', () => { throw new Error('CodeMirror loaded by the patch entrypoint') })
vi.mock('./languages', () => { throw new Error('Language engines loaded by the patch entrypoint') })

describe('the editor patch entrypoint', () => {
  it('exports the synchronous patch view without loading file editing engines', () => {
    expect(editor).toHaveProperty('DiffView')
    const markup = renderToStaticMarkup(<editor.DiffView diff={'@@ -1 +1 @@\n-before\n+after'} />)
    expect(markup).toContain('before')
    expect(markup).toContain('after')
  })

  it('exports the helpers needed by existing readers', () => {
    expect(editor).toHaveProperty('countFileChange')
    expect(editor).toHaveProperty('splitByFile')
    expect(editor).toHaveProperty('splitHunks')
    expect(editor).toHaveProperty('wholeTextDiff')
    expect(editor.countFileChange({ kind: { type: 'delete' }, diff: 'one\ntwo' })).toEqual({ added: 0, removed: 2 })
    expect(editor.splitByFile('diff --git a/file.txt b/file.txt\n@@ -1 +1 @@\n-before\n+after')[0]?.path).toBe('file.txt')
    expect(editor.splitHunks('@@ -1 +1 @@\n-before\n+after')).toHaveLength(1)
    expect(editor.wholeTextDiff('before', 'after')).toContain('-before\n+after')
  })
})
