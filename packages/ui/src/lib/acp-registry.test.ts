import { describe, expect, it } from 'vitest'

import type { AcpRegistryAgentInfo } from '@harnessdesk/protocol'

import {
  registryAddLabel,
  registryMatches,
  registryOrder,
  registryRunSentence,
  registrySentence,
} from './acp-registry'

/**
 * The registry list's pure half. What these hold to: the blocked never rank
 * above the addable, search reads the words a person knows the agent by, and
 * a row's second line is the description when it can be added and the reason
 * when it cannot — never both, never neither when one exists.
 */

const agent = (over: Partial<AcpRegistryAgentInfo>): AcpRegistryAgentInfo => ({
  id: 'a',
  name: 'A',
  version: '1.0.0',
  run: 'npx',
  available: true,
  registered: false,
  ...over,
})

describe('registryOrder', () => {
  it('puts the addable before the blocked, alphabetical inside each half', () => {
    const listed = registryOrder([
      agent({ id: 'zeta', name: 'Zeta' }),
      agent({ id: 'blocked', name: 'Aardvark', available: false, reason: 'No build.' }),
      agent({ id: 'alpha', name: 'alpha' }),
    ])
    expect(listed.map((entry) => entry.id)).toEqual(['alpha', 'zeta', 'blocked'])
  })
})

describe('registryMatches', () => {
  const goose = agent({ id: 'goose', name: 'goose', description: 'An extensible AI agent from Block' })

  it('finds by name, id and description, case-insensitively', () => {
    expect(registryMatches(goose, 'GOOSE')).toBe(true)
    expect(registryMatches(goose, 'block')).toBe(true)
    expect(registryMatches(goose, 'cursor')).toBe(false)
  })

  it('matches everything on empty text', () => {
    expect(registryMatches(goose, '  ')).toBe(true)
  })
})

describe('registrySentence', () => {
  it('is the description while the agent can be added', () => {
    expect(registrySentence(agent({ description: 'Does things.' }))).toBe('Does things.')
  })

  it('is the reason once it cannot, even with a description to show', () => {
    expect(
      registrySentence(
        agent({ description: 'Does things.', available: false, reason: 'Needs uvx.' }),
      ),
    ).toBe('Needs uvx.')
  })

  it('is null when there is nothing to say', () => {
    expect(registrySentence(agent({}))).toBeNull()
  })
})

describe('registryAddLabel', () => {
  it('says a binary downloads — before the click, and during it', () => {
    // The disclosure is the idle label: the click starts a download, so the
    // button says so while there is still time not to click it.
    expect(registryAddLabel(agent({ run: 'binary' }), false)).toBe('Download')
    expect(registryAddLabel(agent({ run: 'binary' }), true)).toBe('Downloading…')
    expect(registryAddLabel(agent({}), false)).toBe('Add')
    expect(registryAddLabel(agent({}), true)).toBe('Adding…')
  })
})

describe('an entry whose agent is already installed', () => {
  const have = agent({
    id: 'opencode',
    name: 'OpenCode',
    run: 'binary',
    description: 'The open source coding agent',
    installed: { path: '/opt/homebrew/bin/opencode', version: '1.18.29', channelLabel: 'Homebrew' },
  })

  it('says so instead of describing itself, and adds without downloading', () => {
    expect(registrySentence(have)).toBe('Already installed — 1.18.29 via Homebrew.')
    // The download that is not happening is said on the button, not a second
    // time in a sentence the cell has no third line for.
    expect(registryAddLabel(have, false)).toBe('Add')
    expect(registryAddLabel(have, true)).toBe('Adding…')
    expect(registryRunSentence(have)).toContain('copy already on this machine (/opt/homebrew/bin/opencode)')
  })

  it('goes back to its description once registered', () => {
    expect(registrySentence({ ...have, registered: true })).toBe('The open source coding agent')
  })
})
