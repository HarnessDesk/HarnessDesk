import assert from 'node:assert/strict'
import { test } from 'node:test'

import { developerToolsEnvironment, type DeveloperToolsOptions } from '../../src/installs/developer-tools.js'

const tools = '/Library/Developer/CommandLineTools'
const selected = '/Applications/Xcode.app/Contents/Developer'
const optedIn = { HARNESSDESK_COMMAND_LINE_TOOLS: '1' }
const options = (extra: DeveloperToolsOptions = {}): DeveloperToolsOptions => ({
  platform: 'darwin', env: optedIn, isDirectory: (path) => path === tools,
  selectedDirectory: () => `${selected}\n`, ...extra,
})

test('an explicit opt-in selects installed Command Line Tools when Xcode is selected, and logs the cost', () => {
  const messages: string[] = []
  const env = developerToolsEnvironment(options({ log: (message) => messages.push(message) }))
  assert.deepEqual(env, { DEVELOPER_DIR: tools })
  assert.deepEqual(optedIn, { HARNESSDESK_COMMAND_LINE_TOOLS: '1' }, 'the host environment is not mutated')
  assert.match(messages.join('\n'), /Xcode.*iOS/)
  assert.match(messages.join('\n'), /HARNESSDESK_COMMAND_LINE_TOOLS/)
})

test('the default and an explicit developer directory never probe or change the environment', () => {
  const unexpected = () => { assert.fail('no probe without permission to change the directory') }
  for (const env of [{}, { HARNESSDESK_COMMAND_LINE_TOOLS: '0' },
    { ...optedIn, DEVELOPER_DIR: selected }, { ...optedIn, DEVELOPER_DIR: '' }]) {
    assert.deepEqual(developerToolsEnvironment(options({ env, selectedDirectory: unexpected, isDirectory: unexpected })), {})
  }
})

test('non-macOS hosts do not probe or change their developer environment', () => {
  for (const platform of ['linux', 'win32'] as const) {
    assert.deepEqual(developerToolsEnvironment(options({ platform,
      selectedDirectory: () => { assert.fail('macOS probe on another platform') },
      isDirectory: () => { assert.fail('macOS folder probe on another platform') },
    })), {})
  }
})

test('missing tools, other selected directories and failed probes keep the environment', () => {
  assert.deepEqual(developerToolsEnvironment(options({ isDirectory: () => false })), {})
  for (const answer of [tools, '', '/some/tools', '/Applications/Xcode.app/Contents/Developer/extra']) {
    assert.deepEqual(developerToolsEnvironment(options({ selectedDirectory: () => answer })), {})
  }
  assert.deepEqual(developerToolsEnvironment(options({ selectedDirectory: () => { throw new Error('unavailable') } })), {})
  assert.deepEqual(developerToolsEnvironment(options({ isDirectory: () => { throw new Error('unreadable') } })), {})
})

test('a renamed Xcode application and a trailing slash still select installed tools', () => {
  assert.deepEqual(developerToolsEnvironment(options({ selectedDirectory: () => '/Applications/Xcode Beta.app/Contents/Developer/\n' })),
    { DEVELOPER_DIR: tools })
})
