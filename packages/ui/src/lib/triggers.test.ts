import { describe, expect, test } from 'vitest'

import { cycle, detectTrigger, stripMention, stripTrigger } from './triggers'

describe('detectTrigger', () => {
  test('a slash at the start opens commands', () => {
    expect(detectTrigger('/')).toEqual({ kind: 'command', query: '' })
    expect(detectTrigger('/mod')).toEqual({ kind: 'command', query: 'mod' })
  })

  test('a slash on a later line also opens commands', () => {
    expect(detectTrigger('hello\n/plan')).toEqual({ kind: 'command', query: 'plan' })
  })

  test('a path is not a command', () => {
    // The single most common false positive: someone typing a file path.
    expect(detectTrigger('look at src/index.ts')).toEqual({ kind: 'none' })
    expect(detectTrigger('/usr/local/bin')).toEqual({ kind: 'none' })
  })

  test('a slash mid-sentence is not a command', () => {
    expect(detectTrigger('and/or')).toEqual({ kind: 'none' })
  })

  test('an at-sign starting a word opens the file picker', () => {
    expect(detectTrigger('@')).toEqual({ kind: 'file', query: '' })
    expect(detectTrigger('check @read')).toEqual({ kind: 'file', query: 'read' })
  })

  test('an email address does not open the file picker', () => {
    expect(detectTrigger('mail me at user@example.com')).toEqual({ kind: 'none' })
  })

  test('a completed trigger closes once whitespace follows', () => {
    expect(detectTrigger('/model ')).toEqual({ kind: 'none' })
    expect(detectTrigger('@file.ts and then')).toEqual({ kind: 'none' })
  })

  test('commands take precedence at the start of a line', () => {
    expect(detectTrigger('/mo')).toEqual({ kind: 'command', query: 'mo' })
  })
})

describe('stripTrigger', () => {
  test('removes the command but keeps surrounding text', () => {
    expect(stripTrigger('/rename', 'command')).toBe('')
    expect(stripTrigger('first line\n/plan', 'command')).toBe('first line\n')
  })

  test('removes the mention token but keeps the separating space', () => {
    expect(stripTrigger('check @rea', 'file')).toBe('check ')
    expect(stripTrigger('@rea', 'file')).toBe('')
    expect(stripTrigger('hello @file', 'file')).toBe('hello ')
    expect(stripTrigger('@file', 'file')).toBe('')
  })

  test('preserves preceding whitespace including newlines and tabs', () => {
    expect(stripTrigger('line 1\n@file', 'file')).toBe('line 1\n')
    expect(stripTrigger('a\t@x', 'file')).toBe('a\t')
  })
})

describe('stripMention', () => {
  test('preserves preceding whitespace including newlines and tabs', () => {
    expect(stripMention('line 1\n@file')).toBe('line 1\n')
    expect(stripMention('a\t@x')).toBe('a\t')
    expect(stripMention('hello @file')).toBe('hello ')
    expect(stripMention('@file')).toBe('')
  })
})

describe('cycle', () => {
  test('wraps in both directions', () => {
    expect(cycle(0, 1, 3)).toBe(1)
    expect(cycle(2, 1, 3)).toBe(0)
    expect(cycle(0, -1, 3)).toBe(2)
  })

  test('is safe with an empty list', () => {
    expect(cycle(0, 1, 0)).toBe(0)
  })
})
