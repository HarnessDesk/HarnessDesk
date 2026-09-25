import { describe, expect, it } from 'vitest'

import { readToolResult } from './tool-result'

/**
 * A tool result's own envelope, read once regardless of which runtime sent
 * it. Fixtures here are shaped exactly like what each runtime answers with,
 * with no real paths or content, so the recognition can be checked without
 * a live transcript.
 */

describe('readToolResult', () => {
  it('reads an MCP-shaped content array of text blocks', () => {
    const reading = readToolResult([{ type: 'text', text: 'done' }])
    expect(reading).toEqual({ kind: 'blocks', blocks: [{ type: 'text', text: 'done' }] })
  })

  it('reads a content array of image blocks', () => {
    const reading = readToolResult([{ type: 'image', url: 'https://example.test/x.png', mimeType: 'image/png' }])
    expect(reading).toEqual({
      kind: 'blocks',
      blocks: [{ type: 'image', url: 'https://example.test/x.png', mimeType: 'image/png' }],
    })
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
    expect(reading).toEqual({ kind: 'blocks', blocks: [{ type: 'text', text: 'wrapped' }] })
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
})
