import { describe, expect, test } from 'vitest'
import type { RuntimeInfo } from '@harnessdesk/protocol'

import { STALE_AFTER_MS, describeChecked, describeUpdate, describeVersion, isStale } from './versions'

const info = (overrides: Partial<RuntimeInfo>): RuntimeInfo =>
  ({
    id: 'codex',
    name: 'Codex',
    version: null,
    capabilities: {},
    presentation: { name: 'Codex' },
    ...overrides,
  }) as RuntimeInfo

describe('describeVersion', () => {
  test('names the runtime and its build, or nothing when none is known', () => {
    expect(describeVersion(info({ version: '0.135.0' }))).toBe('Codex 0.135.0')
    // What `--version` printed, trimmed to the release: the name is already there.
    expect(describeVersion(info({ version: 'codex-cli 0.135.0' }))).toBe('Codex 0.135.0')
    expect(describeVersion(info({ version: 'nightly' }))).toBe('Codex nightly')
    expect(describeVersion(info({}))).toBeNull()
  })

  test('puts the driven agent first for a bridge, then the bridge', () => {
    const bridge = info({
      presentation: { name: 'Claude Code' },
      version: '0.16.2',
      drives: { command: 'claude', version: '2.1.240' },
    })
    expect(describeVersion(bridge)).toBe('Claude Code 2.1.240 · bridge 0.16.2')
    // A bridge that found no CLI runs its embedded copy; only its own version is known.
    expect(describeVersion(info({ presentation: { name: 'Claude Code' }, version: '0.16.2', drives: null }))).toBe(
      'Claude Code 0.16.2',
    )
  })
})

describe('describeUpdate', () => {
  test('says what is available, why it matters, and what to run', () => {
    const described = describeUpdate(
      info({ version: '0.135.0', update: { version: '0.149.0', command: 'brew upgrade codex' } }),
    )
    expect(described?.text).toContain('Codex 0.149.0 is available')
    expect(described?.text).toContain('models')
    expect(described?.command).toBe('brew upgrade codex')
    expect(describeUpdate(info({ version: '0.149.0' }))).toBeNull()
  })
})

describe('describeChecked and isStale', () => {
  const now = new Date(2026, 7, 22, 16, 41).getTime()

  test('says when the list was last re-read, today as a time', () => {
    expect(describeChecked(info({ catalogCheckedAt: now - 60_000 }), now)).toBe('models checked 4:40 PM')
    expect(describeChecked(info({}), now)).toBeNull()
  })

  test('a returning window re-asks only after the answer is old enough to doubt', () => {
    expect(isStale(info({}), now)).toBe(true)
    expect(isStale(info({ catalogCheckedAt: now - 1000 }), now)).toBe(false)
    expect(isStale(info({ catalogCheckedAt: now - STALE_AFTER_MS - 1 }), now)).toBe(true)
  })
})
