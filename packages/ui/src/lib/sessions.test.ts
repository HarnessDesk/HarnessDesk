import { describe, expect, it } from 'vitest'

import { sessionLabel, shortLabel } from './sessions'

describe('sessionLabel', () => {
  it('keeps words that only start with <context as the name (review of #207)', () => {
    // The bridge keeps such a name now, and this is where the row is drawn from it.
    expect(sessionLabel(null, '<context-free grammars, explained')).toBe('<context-free grammars, explained')
    expect(sessionLabel('<context switching in Go', null)).toBe('<context switching in Go')
  })

  it('prefers the title', () => {
    expect(sessionLabel('Pong', 'build pong')).toBe('Pong')
  })
  it('names an untitled conversation by what the user wrote, not the context block', () => {
    expect(sessionLabel(null, '<context source="Handed off from X">\n## Goal\nx\n</context>\n\nAdd a New game button\nmore')).toBe(
      'Add a New game button',
    )
  })
  it('cleans a title that was stored with the block in it', () => {
    expect(sessionLabel('<context source="x">stuff</context>\nReal title', null)).toBe('Real title')
  })
  it('treats a truncated, unterminated block as no name at all', () => {
    expect(sessionLabel('<context source="Uncommitted changes">', null)).toBe('Untitled session')
    expect(sessionLabel('<context source="Uncommitted changes">', 'hello there')).toBe('hello there')
  })
  it('falls back when there is nothing to say', () => {
    expect(sessionLabel(null, '')).toBe('Untitled session')
    expect(sessionLabel(null, null, 'an untitled conversation')).toBe('an untitled conversation')
  })
})

describe('shortLabel', () => {
  it('leaves a name that already fits alone', () => {
    expect(shortLabel('Pong')).toBe('Pong')
  })
  it('cuts a whole prompt down to its opening sentence', () => {
    const ask =
      'Build a small Tic-Tac-Toe web game in this folder: a single index.html with inline CSS and JS. ' +
      'Two players on one screen, win and draw detection, a status line, and a New Game button.'
    expect(shortLabel(ask)).toBe('Build a small Tic-Tac-Toe web game in this folder')
  })
  it('does not mistake a dot inside a filename or a version for a sentence end', () => {
    expect(shortLabel('Rewrite index.html and bump to v1.2 so the board resets')).toBe(
      'Rewrite index.html and bump to v1.2 so the board resets',
    )
  })
  it('ellipsises on a word boundary when there is no sentence to cut at', () => {
    expect(shortLabel('Add a New game button to the board and wire it up to reset the score and the status line')).toBe(
      'Add a New game button to the board and wire it up to reset…',
    )
  })
  it('ignores a leading interjection that names nothing', () => {
    expect(shortLabel('OK. Now add a New game button')).toBe('OK. Now add a New game button')
  })
  it('falls through to a word-boundary cut when the first sentence is itself too long', () => {
    const ask = `${'word '.repeat(20)}stops. And then some more.`
    const short = shortLabel(ask)
    expect(short.endsWith('…')).toBe(true)
    expect(short.length).toBeLessThanOrEqual(61)
    expect(short).not.toMatch(/\s…$/)
  })
  it('drops a trailing period so a one-sentence ask reads as a name', () => {
    expect(shortLabel('Fix the footer.')).toBe('Fix the footer')
  })
  it('honours a caller-supplied limit', () => {
    expect(shortLabel('Add a New game button to the board', 20)).toBe('Add a New game…')
  })
})

describe('sessionLabel, for a message that is only blocks', () => {
  it('is called by its first block, the hand-off, in the list and in the header alike (#186)', () => {
    // A hand-off sent with a context chip and nothing typed: the packet first, then the chip.
    const handOff = '<context source="Handed off from Claude — “Migrate”">\n## Goal\nMigrate\n</context>\n<context source="Git">\nOn main\n</context>'
    expect(sessionLabel(null, handOff)).toBe('Handed off from Claude — “Migrate”')
    expect(sessionLabel(null, handOff, 'New session')).toBe('Handed off from Claude — “Migrate”')
  })
})
