import { describe, expect, it } from 'vitest'

import { readToolResult, resultPartsToDraw } from './tool-result'

/**
 * A tool result's own envelope, read once regardless of which runtime sent
 * it. Fixtures here are shaped exactly like what each runtime answers with,
 * with no real paths or content, so the recognition can be checked without
 * a live transcript.
 */

describe('readToolResult', () => {
  it('reads an MCP-shaped content array of text blocks', () => {
    const reading = readToolResult([{ type: 'text', text: 'done' }])
    expect(reading).toEqual({ kind: 'blocks', blocks: [{ type: 'text', text: 'done' }], error: false })
  })

  it('reads a content array of image blocks', () => {
    const reading = readToolResult([{ type: 'image', url: 'https://example.test/x.png', mimeType: 'image/png' }])
    expect(reading).toEqual({
      kind: 'blocks',
      error: false,
      blocks: [{ type: 'image', url: 'https://example.test/x.png', mimeType: 'image/png' }],
    })
  })

  it('skips an image the adapter already drew beside the result, keeping the rest', () => {
    expect(readToolResult([{ type: 'image', data: '(shown below)' }])).toEqual({ kind: 'blocks', blocks: [], error: false })
    expect(readToolResult([{ type: 'text', text: 'Saved.' }, { type: 'image', data: '(shown below)' }])).toEqual({
      kind: 'blocks',
      error: false,
      blocks: [{ type: 'text', text: 'Saved.' }],
    })
  })

  it('reads a base64 image in either the MCP or the model API shape as a data URL', () => {
    expect(readToolResult([{ type: 'image', data: 'AAAA', mimeType: 'image/png' }])).toEqual({
      kind: 'blocks',
      error: false,
      blocks: [{ type: 'image', url: 'data:image/png;base64,AAAA', mimeType: 'image/png' }],
    })
    expect(readToolResult([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }])).toEqual({
      kind: 'blocks',
      error: false,
      blocks: [{ type: 'image', url: 'data:image/jpeg;base64,BBBB', mimeType: 'image/jpeg' }],
    })
  })

  it('falls back to json for an image block with nothing to draw', () => {
    expect(readToolResult([{ type: 'image' }])).toEqual({ kind: 'json' })
  })

  it('reads a mixed text-and-image content array', () => {
    const reading = readToolResult([
      { type: 'text', text: 'here is a screenshot' },
      { type: 'image', url: 'https://example.test/y.png' },
    ])
    expect(reading.kind).toBe('blocks')
    expect(reading.kind === 'blocks' && reading.blocks).toEqual([
      { type: 'text', text: 'here is a screenshot' },
      { type: 'image', url: 'https://example.test/y.png' },
    ])
  })

  it('unwraps a {content: [...]} wrapper the same way as a bare array', () => {
    const reading = readToolResult({ content: [{ type: 'text', text: 'wrapped' }] })
    expect(reading).toEqual({ kind: 'blocks', blocks: [{ type: 'text', text: 'wrapped' }], error: false })
  })

  it('falls back to json for a whole array when one element is an unrecognised block', () => {
    // A partly-recognised array (a `tool_reference` block beside a text one)
    // stays JSON as a whole, rather than drawing the text and dropping the rest.
    const reading = readToolResult([
      { type: 'text', text: 'part one' },
      { type: 'tool_reference', id: 'ref-1' },
    ])
    expect(reading).toEqual({ kind: 'json' })
  })

  it('reads a command record, preferring combinedOutput over formatted_output and exitCode over exit_code', () => {
    const reading = readToolResult({
      commandLine: 'ls -la',
      workingDir: '/work',
      exitCode: 0,
      exit_code: 0,
      combinedOutput: 'total 0',
      formatted_output: 'total 0 (formatted)',
    })
    expect(reading).toEqual({ kind: 'command', command: 'ls -la', output: 'total 0', exitCode: 0 })
  })

  it('falls back to formatted_output when combinedOutput is missing', () => {
    const reading = readToolResult({ commandLine: 'ls -la', formatted_output: 'total 0' })
    expect(reading).toEqual({ kind: 'command', command: 'ls -la', output: 'total 0' })
  })

  it('reads a non-zero exit code on a command record', () => {
    const reading = readToolResult({ commandLine: 'false', exit_code: 1, combinedOutput: '' })
    expect(reading).toEqual({ kind: 'command', command: 'false', output: '', exitCode: 1 })
  })

  it('reads a bare output-and-error pair', () => {
    expect(readToolResult({ output: 'all clear', isError: false })).toEqual({
      kind: 'output',
      text: 'all clear',
      error: false,
    })
    expect(readToolResult({ output: 'boom', isError: true })).toEqual({
      kind: 'output',
      text: 'boom',
      error: true,
    })
  })

  it('falls back to json for a shape none of the known kinds name', () => {
    expect(readToolResult({ ok: true, count: 3 })).toEqual({ kind: 'json' })
    expect(readToolResult('a bare string')).toEqual({ kind: 'json' })
    expect(readToolResult(null)).toEqual({ kind: 'json' })
    expect(readToolResult([1, 2, 3])).toEqual({ kind: 'json' })
  })

  it('does not read an object that merely has a commandLine key without output', () => {
    expect(readToolResult({ commandLine: 'ls' })).toEqual({ kind: 'json' })
  })

  it('does not read an object that merely has an output key without isError', () => {
    expect(readToolResult({ output: 'text' })).toEqual({ kind: 'json' })
  })
  it('leaves a result carrying keys beyond its envelope as JSON, so nothing is dropped', () => {
    expect(readToolResult({ output: 'x', isError: false, rows: 3 })).toEqual({ kind: 'json' })
    expect(readToolResult({ content: [{ type: 'text', text: 'x' }], structuredContent: { a: 1 } })).toEqual({ kind: 'json' })
    expect(readToolResult({ commandLine: 'ls', combinedOutput: '', pid: 4 })).toEqual({ kind: 'json' })
  })

})

describe('resultPartsToDraw', () => {
  const text = { type: 'text' as const, text: '3 matches in 2 files' }
  const drawnParts = (parts: Parameters<typeof resultPartsToDraw>[0]) =>
    resultPartsToDraw(parts).map(({ part }) => part)

  it.each([
    ['a string', '3 matches in 2 files'],
    ['an output pair', { output: '3 matches in 2 files', isError: false }],
    ['text blocks', [{ type: 'text', text: '3 matches in 2 files' }]],
    ['a one-key record', { text: '3 matches in 2 files' }],
  ])('drops JSON that only restates text as %s', (_shape, value) => {
    expect(drawnParts([text, { type: 'json', value }])).toEqual([text])
  })

  it('drops a string that restates all text parts joined with newlines', () => {
    const parts = [
      { type: 'text' as const, text: '3 matches' },
      { type: 'text' as const, text: 'in 2 files' },
      { type: 'json' as const, value: '3 matches\nin 2 files' },
    ]
    expect(drawnParts(parts)).toEqual(parts.slice(0, 2))
  })

  it('compares readable output after trimming whitespace', () => {
    expect(drawnParts([text, { type: 'json', value: '  3 matches in 2 files  \n' }])).toEqual([text])
  })

  it.each([
    ['a record with more keys', { text: '3 matches in 2 files', files: ['a', 'b'] }],
    ['a command reading', { commandLine: 'find .', combinedOutput: '3 matches in 2 files' }],
    ['text that differs', '3 matches in 3 files'],
  ])('keeps JSON that carries %s', (_shape, value) => {
    const json = { type: 'json' as const, value }
    expect(drawnParts([text, json])).toEqual([text, json])
  })

  it('keeps a JSON part when no text part is beside it', () => {
    const json = { type: 'json' as const, value: '3 matches in 2 files' }
    expect(drawnParts([json])).toEqual([json])
  })

  it('keeps JSON blocks whose readable result also contains an image', () => {
    const json = {
      type: 'json' as const,
      value: [
        { type: 'text', text: '3 matches in 2 files' },
        { type: 'image', url: 'https://example.test/image.png' },
      ],
    }
    expect(drawnParts([text, json])).toEqual([text, json])
  })

  it.each([
    ['error', { error: 'x' }],
    ['path', { path: 'x' }],
  ])('keeps the one-key %s record beside matching text', (_key, value) => {
    const json = { type: 'json' as const, value }
    expect(drawnParts([{ type: 'text', text: 'x' }, json])).toEqual([{ type: 'text', text: 'x' }, json])
  })

  it('drops a one-key stdout record that repeats text', () => {
    expect(drawnParts([{ type: 'text', text: 'x' }, { type: 'json', value: { stdout: 'x' } }])).toEqual([
      { type: 'text', text: 'x' },
    ])
  })

  it('keeps an output reading marked as an error', () => {
    const json = { type: 'json' as const, value: { output: 'x', isError: true } }
    expect(drawnParts([{ type: 'text', text: 'x' }, json])).toEqual([{ type: 'text', text: 'x' }, json])
  })

  it('keeps each drawn part keyed by its original input index', () => {
    const parts = [
      text,
      { type: 'json' as const, value: '3 matches in 2 files' },
      { type: 'image' as const, url: 'https://example.test/image.png' },
    ]
    expect(resultPartsToDraw(parts)).toEqual([
      { part: text, index: 0 },
      { part: parts[2], index: 2 },
    ])
  })
})
