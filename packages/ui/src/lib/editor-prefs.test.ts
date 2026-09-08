import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EDITOR_PREFS,
  INHERITED_CODE_FACE,
  editorLook,
  installedFaces,
  readEditorPrefs,
} from './editor-prefs'

describe('readEditorPrefs', () => {
  it('fills an absent preference with the defaults', () => {
    expect(readEditorPrefs(undefined)).toEqual(DEFAULT_EDITOR_PREFS)
    expect(readEditorPrefs(null)).toEqual(DEFAULT_EDITOR_PREFS)
    expect(readEditorPrefs('nonsense')).toEqual(DEFAULT_EDITOR_PREFS)
  })

  it('keeps what a stored preference does say', () => {
    const stored = { fontSize: 16, lineNumbers: false, wrap: true, tabSize: 4 }
    expect(readEditorPrefs(stored)).toMatchObject(stored)
  })

  it('clamps a size that would render the pane unusable', () => {
    // The failure this exists for: these values reach CodeMirror as CSS, so a
    // zero survives all the way to an editor with no way back to the setting.
    expect(readEditorPrefs({ fontSize: 0 }).fontSize).toBe(9)
    expect(readEditorPrefs({ fontSize: 900 }).fontSize).toBe(28)
    expect(readEditorPrefs({ fontSize: Number.NaN }).fontSize).toBe(DEFAULT_EDITOR_PREFS.fontSize)
    expect(readEditorPrefs({ lineHeight: 0.1 }).lineHeight).toBe(1.1)
    expect(readEditorPrefs({ lineHeight: 40 }).lineHeight).toBe(2.4)
  })

  it('refuses an indent width no formatter agrees with', () => {
    expect(readEditorPrefs({ tabSize: 3 }).tabSize).toBe(DEFAULT_EDITOR_PREFS.tabSize)
    expect(readEditorPrefs({ tabSize: 4 }).tabSize).toBe(4)
  })

  it('ignores a value of the wrong type rather than passing it through', () => {
    expect(readEditorPrefs({ lineNumbers: 'yes' }).lineNumbers).toBe(true)
    expect(readEditorPrefs({ fontFamily: 12 }).fontFamily).toBe('')
  })
})

describe('editorLook', () => {
  it('resolves the empty family to the app token, so the palette keeps reaching it', () => {
    expect(editorLook(DEFAULT_EDITOR_PREFS).fontFamily).toBe(INHERITED_CODE_FACE)
    expect(editorLook({ ...DEFAULT_EDITOR_PREFS, fontFamily: '   ' }).fontFamily).toBe(
      INHERITED_CODE_FACE,
    )
  })

  it('passes a chosen family through untouched', () => {
    const stack = "'Fira Code', monospace"
    expect(editorLook({ ...DEFAULT_EDITOR_PREFS, fontFamily: stack }).fontFamily).toBe(stack)
  })
})

describe('installedFaces', () => {
  it('offers nothing when the machine cannot be asked', () => {
    expect(installedFaces(undefined)).toEqual([])
    expect(installedFaces({} as FontFaceSet)).toEqual([])
  })

  it('offers only what the machine reports it has', () => {
    const fonts = { check: (spec: string) => spec.includes('Menlo') } as FontFaceSet
    const found = installedFaces(fonts)
    expect(found.map((face) => face.name)).toEqual(['Menlo'])
  })

  it('survives a family name the font API refuses to parse', () => {
    // One unquotable name must not empty the whole list.
    const fonts = {
      check: (spec: string) => {
        if (spec.includes('Fira Code')) throw new SyntaxError('bad spec')
        return spec.includes('Menlo')
      },
    } as FontFaceSet
    expect(installedFaces(fonts).map((face) => face.name)).toEqual(['Menlo'])
  })
})
