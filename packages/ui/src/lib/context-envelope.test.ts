import { describe, expect, test } from 'vitest'

import { splitContext, wrapContext } from './context-envelope'

/**
 * Injected context is sent as user input because that is the only channel the
 * runtime offers. These tests protect the one thing that makes that honest: the
 * renderer must always be able to tell it apart from what the user typed.
 */

describe('splitContext', () => {
  test('plain text passes through untouched', () => {
    expect(splitContext('just a message')).toEqual({ injections: [], text: 'just a message' })
  })

  test('an envelope is separated from the user text', () => {
    const raw = `${wrapContext('Git', 'On branch main.')}\n\nfix the tests`
    const result = splitContext(raw)
    expect(result.injections).toEqual([{ label: 'Git', text: 'On branch main.' }])
    expect(result.text).toBe('fix the tests')
  })

  test('a body quoting the envelope itself round-trips whole', () => {
    const body = 'The desk wraps context like this:\n<context source="Git">\non main\n</context>\nand strips it on render.'
    const raw = `${wrapContext('Handed off', body)}\n\ncontinue from here`
    const result = splitContext(raw)
    expect(result.injections).toEqual([{ label: 'Handed off', text: body }])
    expect(result.text).toBe('continue from here')
  })

  test('several envelopes are all extracted, in order', () => {
    const raw = [wrapContext('Git', 'branch main'), wrapContext('Plan mode', 'propose first'), 'go'].join('\n\n')
    const result = splitContext(raw)
    expect(result.injections.map((entry) => entry.label)).toEqual(['Git', 'Plan mode'])
    expect(result.text).toBe('go')
  })

  test('a label containing quotes round-trips', () => {
    const raw = wrapContext('the "main" repo', 'body')
    expect(splitContext(raw).injections[0]?.label).toBe('the "main" repo')
  })

  test('multi-line bodies survive intact', () => {
    const body = 'line one\nline two\n\nline four'
    expect(splitContext(wrapContext('Notes', body)).injections[0]?.text).toBe(body)
  })

  test('a context-only message leaves no stray whitespace behind', () => {
    expect(splitContext(wrapContext('Git', 'x')).text).toBe('')
  })

  test('text that merely mentions the marker is not mangled', () => {
    // A user asking about the envelope itself must still see their own words.
    const raw = 'what does <context source= mean?'
    expect(splitContext(raw).text).toBe(raw)
    expect(splitContext(raw).injections).toEqual([])
  })
})
