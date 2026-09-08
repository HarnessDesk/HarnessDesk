import { describe, expect, it } from 'vitest'

import { codeSpans, splitHealth, type Unavailable } from './health'

const health = (message: string, remediation?: string): Unavailable => ({
  state: 'unavailable',
  reason: 'unknown',
  message,
  ...(remediation ? { remediation } : {}),
})

describe('splitHealth', () => {
  it("keeps our sentence and the agent's own output apart", () => {
    const parts = splitHealth(
      health(
        'OpenClaw refuses its own configuration:\nOpenClaw config is invalid: ~/.openclaw/openclaw.json\n× openclaw.json:533 — meta: Unrecognized key: "lastTouchedAt"',
        '`openclaw doctor --fix` migrates the keys it knows.',
      ),
    )
    expect(parts.lead).toBe('OpenClaw refuses its own configuration')
    expect(parts.detail).toBe(
      'OpenClaw config is invalid: ~/.openclaw/openclaw.json\n× openclaw.json:533 — meta: Unrecognized key: "lastTouchedAt"',
    )
    expect(parts.remediation).toBe('`openclaw doctor --fix` migrates the keys it knows.')
  })

  it('leaves a one-line message as one sentence, with no block under it', () => {
    const parts = splitHealth(
      health('Gemini CLI is not installed on this machine.', 'Install it with `npm i -g x`.'),
    )
    expect(parts.lead).toBe('Gemini CLI is not installed on this machine.')
    expect(parts.detail).toBeNull()
  })

  it('has nothing to say about a message that is only whitespace after its first line', () => {
    expect(splitHealth(health('Broken.\n\n  \n')).detail).toBeNull()
    expect(splitHealth(health('Broken.')).remediation).toBeNull()
  })
})

describe('codeSpans', () => {
  it('sets what is between backticks as code and leaves the rest alone', () => {
    expect(codeSpans('Install it with `npm i -g x`.')).toEqual([
      { text: 'Install it with ', code: false },
      { text: 'npm i -g x', code: true },
      { text: '.', code: false },
    ])
  })

  it('reads several spans, and starts at the first character', () => {
    expect(codeSpans('`a` then `b`')).toEqual([
      { text: 'a', code: true },
      { text: ' then ', code: false },
      { text: 'b', code: true },
    ])
  })

  it('leaves an unpaired backtick as the character it is', () => {
    expect(codeSpans('a ` b')).toEqual([{ text: 'a ` b', code: false }])
    expect(codeSpans('')).toEqual([])
    expect(codeSpans('plain')).toEqual([{ text: 'plain', code: false }])
  })
})
