import { describe, expect, it } from 'vitest'
import { Text } from '@codemirror/state'

import { asDiagnostics, knownLanguages, languageForPath, loadLanguage } from './editor'

describe('languageForPath', () => {
  it('reads an ordinary extension', () => {
    expect(languageForPath('src/app.ts')).toBe('typescript')
    expect(languageForPath('/abs/path/main.py')).toBe('python')
    expect(languageForPath('Cargo.toml')).toBe('toml')
    expect(languageForPath('a\\windows\\path.rs')).toBe('rust')
  })

  it('folds the aliases onto one grammar', () => {
    for (const path of ['a.js', 'a.mjs', 'a.cjs', 'a.jsx']) {
      expect(languageForPath(path)).toBe('javascript')
    }
    for (const path of ['a.ts', 'a.tsx', 'a.mts']) {
      expect(languageForPath(path)).toBe('typescript')
    }
    expect(languageForPath('a.yml')).toBe('yaml')
    expect(languageForPath('a.h')).toBe('cpp')
  })

  it('names a file that is its own extension', () => {
    // The case a naive `split('.').pop()` gets wrong in both directions.
    expect(languageForPath('Dockerfile')).toBe('dockerfile')
    expect(languageForPath('.gitignore')).toBe('properties')
    expect(languageForPath('/repo/.editorconfig')).toBe('properties')
  })

  it('reads a dotfile with a real extension by that extension', () => {
    expect(languageForPath('.eslintrc.json')).toBe('json')
    expect(languageForPath('.prettierrc.yaml')).toBe('yaml')
  })

  it('answers null rather than guessing', () => {
    expect(languageForPath(null)).toBeNull()
    expect(languageForPath('')).toBeNull()
    expect(languageForPath('notes.xyz')).toBeNull()
    expect(languageForPath('LICENSE')).toBeNull()
  })
})

describe('loadLanguage', () => {
  it('answers null for nothing and for a language it does not have', () => {
    return Promise.all([
      expect(loadLanguage(null)).resolves.toBeNull(),
      expect(loadLanguage('cobol')).resolves.toBeNull(),
    ])
  })

  it('loads a Lezer grammar', async () => {
    await expect(loadLanguage('json')).resolves.not.toBeNull()
  })

  it('loads a stream grammar from the legacy modes', async () => {
    await expect(loadLanguage('shell')).resolves.not.toBeNull()
  })

  it('serves a second call from cache, as the same object', async () => {
    const [first, second] = await Promise.all([loadLanguage('json'), loadLanguage('json')])
    expect(first).toBe(second)
  })
})

describe('asDiagnostics', () => {
  // Five lines, so line 5 is the last and line 6 does not exist.
  const doc = Text.of(['one', 'two', 'three', 'four', 'five'])

  it('reads a 1-based inclusive line range as character offsets', () => {
    const [mark] = asDiagnostics([{ fromLine: 2, toLine: 3, severity: 'error' }], doc)
    expect(mark).toMatchObject({ from: doc.line(2).from, to: doc.line(3).to, severity: 'error' })
  })

  it('marks the whole of a single line when there is no `toLine`', () => {
    const [mark] = asDiagnostics([{ fromLine: 4, severity: 'warning' }], doc)
    expect(mark).toMatchObject({ from: doc.line(4).from, to: doc.line(4).to })
  })

  it('clamps a line the file no longer has instead of throwing', () => {
    // The real case: a plugin reports against the file it read, the person
    // deletes half of it, and the report arrives afterwards. `doc.line(40)`
    // throws — inside CodeMirror's own update cycle, where it takes the
    // editor down with it.
    const marks = asDiagnostics(
      [
        { fromLine: 40, severity: 'error' },
        { fromLine: 0, severity: 'error' },
        { fromLine: -3, toLine: -1, severity: 'info' },
      ],
      doc,
    )
    expect(marks).toHaveLength(3)
    for (const mark of marks) {
      expect(mark.from).toBeGreaterThanOrEqual(0)
      expect(mark.to).toBeLessThanOrEqual(doc.length)
      expect(mark.from).toBeLessThanOrEqual(mark.to)
    }
  })

  it('keeps a range in order when the plugin sent it inverted', () => {
    const [mark] = asDiagnostics([{ fromLine: 4, toLine: 2, severity: 'info' }], doc)
    expect(mark!.from).toBeLessThanOrEqual(mark!.to)
  })

  it('sorts by position, because `setDiagnostics` requires it', () => {
    const marks = asDiagnostics(
      [
        { fromLine: 5, severity: 'error' },
        { fromLine: 1, severity: 'error' },
        { fromLine: 3, severity: 'error' },
      ],
      doc,
    )
    expect(marks.map((mark) => mark.from)).toEqual([...marks.map((mark) => mark.from)].sort((a, b) => a - b))
  })

  it('carries a hint as an info wearing its own class', () => {
    const [hint] = asDiagnostics([{ fromLine: 1, severity: 'hint', message: 'consider' }], doc)
    expect(hint).toMatchObject({ severity: 'info', markClass: 'hd-diag-hint', message: 'consider' })
    const [info] = asDiagnostics([{ fromLine: 1, severity: 'info' }], doc)
    expect(info).not.toHaveProperty('markClass')
  })

  it('gives a message-less mark an empty one rather than undefined', () => {
    // `Diagnostic.message` is not optional; `undefined` renders as the string
    // "undefined" in the tooltip.
    expect(asDiagnostics([{ fromLine: 1, severity: 'error' }], doc)[0]!.message).toBe('')
  })
})

describe('knownLanguages', () => {
  it('covers everything the aliases point at', () => {
    const known = new Set(knownLanguages())
    for (const path of ['a.ts', 'a.py', 'Dockerfile', '.gitignore', 'a.kt', 'a.cs']) {
      const language = languageForPath(path)
      expect(language, `${path} resolved to nothing`).not.toBeNull()
      expect(known.has(language!), `${language} has no loader`).toBe(true)
    }
  })
})
