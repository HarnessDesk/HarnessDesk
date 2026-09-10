import assert from 'node:assert/strict'
import { test } from 'node:test'

import { readChannel } from '../../src/installs/channels.js'

/**
 * #69: a package manager's `.bin` folder was read as a package. pnpm's
 * launchers are shell scripts rather than links, so resolving one leaves the
 * path inside `node_modules/.bin`, and the update the desk offered was
 * `npm install -g .bin`.
 */
test('a launcher in node_modules/.bin names no package', () => {
  const reading = readChannel('/usr/local/lib/node_modules/.bin/claude', {
    realpath: (path) => path,
    home: '/home/ada',
    platform: 'linux',
  })
  assert.equal(reading.channel, 'npm-global')
  assert.equal(reading.packageName, null)
})

test('a package in the same tree is still read, scoped or not', () => {
  const read = (path: string) => readChannel(path, { realpath: (p) => p, home: '/home/ada', platform: 'linux' }).packageName
  assert.equal(read('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'), '@anthropic-ai/claude-code')
  assert.equal(read('/usr/local/lib/node_modules/opencode-ai/bin/opencode'), 'opencode-ai')
})
