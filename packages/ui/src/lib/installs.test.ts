import { describe, expect, it } from 'vitest'

import type { InstallCopy, InstallInfo } from '@harnessdesk/protocol'

import { copyReason, describeCopy, describeFallback, installSummary, pinHolds, standingChip } from './installs'

const copy = (over: Partial<InstallCopy>): InstallCopy => ({
  path: '/opt/homebrew/bin/x',
  version: '1.2.3',
  channel: 'homebrew',
  channelLabel: 'Homebrew',
  standing: 'chosen',
  managed: false,
  updateCommand: 'brew upgrade x',
  ...over,
})

const info = (over: Partial<InstallInfo>): InstallInfo => ({
  copies: [],
  chosen: null,
  policy: 'newest',
  fallback: null,
  checkedAt: 0,
  ...over,
})

describe('installSummary', () => {
  it('names the copy in use and counts the rest', () => {
    const chosen = copy({})
    expect(installSummary(info({ chosen, copies: [chosen, copy({ standing: 'older', version: '1.0.0' })] }))).toBe(
      'Running 1.2.3 · via Homebrew (1 other copy found)',
    )
    expect(installSummary(info({ chosen: copy({ standing: 'pinned' }), policy: 'pinned', copies: [copy({ standing: 'pinned' })] }))).toBe(
      'Pinned to 1.2.3 · via Homebrew',
    )
  })
  it("says when the desk's own download or the row's command answers instead", () => {
    expect(installSummary(info({ fallback: { command: '/x', version: '1.18.27', managed: true } }))).toBe(
      "Running HarnessDesk's own 1.18.27 — nothing else installed",
    )
    expect(
      installSummary(info({ fallback: { command: 'npx -y a@1', version: '1', managed: true }, copies: [copy({ standing: 'too-old', version: '0.1.0' })] })),
    ).toBe("Running HarnessDesk's own 1 — no installed copy qualifies (1 other copy found)")
    expect(installSummary(info({}))).toBe('Not installed')
  })
})

describe('copy lines', () => {
  it('describe the road and the reason', () => {
    expect(describeCopy(copy({}))).toBe('1.2.3 · via Homebrew')
    expect(describeCopy(copy({ managed: true, channel: 'harnessdesk', version: null }))).toBe('version unknown · downloaded by HarnessDesk')
    expect(copyReason(copy({}), info({}))).toBe('/opt/homebrew/bin/x')
    // The command is written as code for whatever renders it, and the two
    // sentences are two sentences.
    expect(copyReason(copy({ standing: 'too-old' }), info({ minVersion: '2.0.0' }))).toBe(
      'Needs 2.0.0. Update it with `brew upgrade x`.',
    )
    expect(copyReason(copy({ standing: 'too-old', updateCommand: null }), info({}))).toBe('Needs a newer build.')
    // A reason the knowledge wrote is already a sentence and is left alone.
    expect(
      copyReason(copy({ standing: 'too-old' }), info({ minVersionReason: '`--acp` replaced the old flag in 0.58.' })),
    ).toBe('`--acp` replaced the old flag in 0.58. Update it with `brew upgrade x`.')
    expect(copyReason(copy({ standing: 'older', updateCommand: null }), info({}))).toBe('Outranked by a newer copy.')
    // The newest copy is the one a pin overrides; the host lists copies newest first (#106).
    const newest = copy({ standing: 'older' })
    expect(copyReason(newest, info({ policy: 'pinned', copies: [newest, copy({ path: '/pin/x', version: '1.0.0', standing: 'pinned' })] }))).toMatch(/pin overrides/)
    expect(copyReason(copy({ standing: 'unreadable' }), info({}))).toMatch(/never run/)
  })
  it('wear a chip each', () => {
    expect(standingChip('chosen')).toEqual({ state: 'ready', label: 'In use' })
    expect(standingChip('too-old').state).toBe('broken')
  })
  it('describe the fallback and the registry update beside it', () => {
    expect(describeFallback(info({ fallback: { command: '/x', version: '1.0.0', managed: true }, registryUpdate: { version: '1.1.0' } }))).toBe(
      '1.0.0 downloaded by HarnessDesk; 1.1.0 is in the registry',
    )
    expect(describeFallback(info({ fallback: { command: 'npx x', version: null, managed: false } }))).toBe('npx x')
    expect(describeFallback(info({}))).toBeNull()
    // The row's own command, already listed as the copy in use, is not said twice.
    const chosen = copy({ path: '/x' })
    expect(describeFallback(info({ chosen, copies: [chosen], fallback: { command: '/x', version: '1.2.3', managed: false } }))).toBeNull()
    // Nor when it is the same program reached by a different spelling — an
    // installed copy answers, so the row's own command has nothing to add.
    expect(
      describeFallback(info({ chosen, copies: [chosen], fallback: { command: 'openclaw acp', version: null, managed: false } })),
    ).toBeNull()
    // It stands when the desk's own download is what could be replaced.
    expect(
      describeFallback(
        info({ chosen, copies: [chosen], fallback: { command: '/dl', version: '1.0.0', managed: true }, registryUpdate: { version: '1.1.0' } }),
      ),
    ).toBe('1.0.0 downloaded by HarnessDesk; 1.1.0 is in the registry')
  })
})

describe('an older copy under a pin', () => {
  // #106: every older copy under a pin was told it would run under the newest-wins rule, though a newer copy outranks most of them either way.
  it('is the one newest-wins would run only when it is the newest', () => {
    const newest = copy({ path: '/new/x', version: '2.0.0', standing: 'older' })
    const pinned = copy({ path: '/pin/x', version: '1.5.0', standing: 'pinned' })
    const oldest = copy({ path: '/old/x', version: '1.0.0', standing: 'older' })
    const pinnedInfo = info({ policy: 'pinned', chosen: pinned, copies: [newest, pinned, oldest] })
    expect(copyReason(newest, pinnedInfo)).toBe('Would run under the newest-wins rule; a pin overrides it.')
    expect(copyReason(oldest, pinnedInfo)).toBe('Outranked by a newer copy. Update it with `brew upgrade x`, or remove it.')
  })
  it('is outranked, as without a pin, when the pinned copy is the newest', () => {
    const pinned = copy({ path: '/pin/x', version: '2.0.0', standing: 'pinned' })
    const older = copy({ path: '/old/x', version: '1.0.0', standing: 'older', updateCommand: null })
    expect(copyReason(older, info({ policy: 'pinned', chosen: pinned, copies: [pinned, older] }))).toBe('Outranked by a newer copy.')
  })
})

describe('a pin whose copy has gone (#219)', () => {
  it('says what runs, not "Pinned to"', () => {
    // The rule picked again, newest first, with the pin still recorded.
    const chosen = copy({ standing: 'chosen' })
    const dead = info({ policy: 'pinned', chosen, copies: [chosen] })
    expect(pinHolds(dead)).toBe(false)
    expect(installSummary(dead)).toBe('Running 1.2.3 · via Homebrew')
    // The control: a pin that holds is still said as one.
    const pinned = copy({ standing: 'pinned' })
    expect(installSummary(info({ policy: 'pinned', chosen: pinned, copies: [pinned] }))).toBe('Pinned to 1.2.3 · via Homebrew')
  })
})
