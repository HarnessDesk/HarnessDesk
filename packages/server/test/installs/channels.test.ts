import assert from 'node:assert/strict'
import { test } from 'node:test'

import { channelLabel, readChannel, updateCommandFor } from '../../src/installs/channels.js'

/**
 * The road a binary took onto the machine, read off its path. What these
 * hold to: symlinks are followed before judging, each package manager's tree
 * names its own package, the desk's download folder is recognised first,
 * and an update command is phrased for the road actually taken.
 */

const HOME = '/Users/x'
const MANAGED = '/Users/x/.harnessdesk/acp-agents'

const read = (path: string, real: string = path) =>
  readChannel(path, { home: HOME, managedDir: MANAGED, platform: 'darwin', realpath: () => real })

test('a Homebrew link is read through to its Cellar and names the formula', () => {
  const reading = read('/opt/homebrew/bin/opencode', '/opt/homebrew/Cellar/opencode/1.18.29/bin/opencode')
  assert.equal(reading.channel, 'homebrew')
  assert.equal(reading.packageName, 'opencode')
  assert.equal(updateCommandFor(reading), 'brew upgrade opencode')
})

test('an npm global bin link names the package, scoped or not', () => {
  const scoped = read(
    '/opt/homebrew/bin/gemini',
    '/opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js',
  )
  assert.equal(scoped.channel, 'npm-global')
  assert.equal(scoped.packageName, '@google/gemini-cli')
  assert.equal(updateCommandFor(scoped), 'npm install -g @google/gemini-cli@latest')

  const plain = read('/Users/x/.npm-global/bin/cline', '/Users/x/.npm-global/lib/node_modules/cline/bin/cline')
  assert.equal(plain.channel, 'npm-global')
  assert.equal(plain.packageName, 'cline')

  const nvm = read('/Users/x/.nvm/versions/node/v22.0.0/bin/cline', '/Users/x/.nvm/versions/node/v22.0.0/lib/node_modules/cline/bin/cline')
  assert.equal(nvm.channel, 'npm-global')
})

test('uv, pipx, bun and cargo trees are told apart', () => {
  const uv = read('/Users/x/.local/bin/kimi', '/Users/x/.local/share/uv/tools/kimi-cli/bin/kimi')
  assert.equal(uv.channel, 'uv-tool')
  assert.equal(uv.packageName, 'kimi-cli')
  assert.equal(updateCommandFor(uv), 'uv tool upgrade kimi-cli')

  const pipx = read('/Users/x/.local/bin/hermes', '/Users/x/.local/pipx/venvs/hermes-agent/bin/hermes')
  assert.equal(pipx.channel, 'pipx')
  assert.equal(updateCommandFor(pipx), 'pipx upgrade hermes-agent')

  const bun = read('/Users/x/.bun/bin/pi', '/Users/x/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')
  assert.equal(bun.channel, 'bun')
  assert.equal(updateCommandFor(bun), 'bun install -g @earendil-works/pi-coding-agent@latest')

  assert.equal(read('/Users/x/.cargo/bin/something').channel, 'cargo')
})

test("the desk's own download folder is recognised before anything else, and by the entry's id", () => {
  const reading = read(`${MANAGED}/opencode/1.18.27/opencode`)
  assert.equal(reading.channel, 'harnessdesk')
  assert.equal(reading.packageName, 'opencode')
  assert.equal(updateCommandFor(reading), null)
})

test('an app bundle, an installer folder and a bare path are each their own road', () => {
  const app = read('/Applications/ChatGPT.app/Contents/Resources/codex')
  assert.equal(app.channel, 'app-bundle')
  assert.equal(app.packageName, 'ChatGPT')

  const installer = read('/Users/x/.opencode/bin/opencode')
  assert.equal(installer.channel, 'installer')
  assert.equal(updateCommandFor(installer, { selfUpdate: 'opencode upgrade' }), 'opencode upgrade')
  assert.equal(updateCommandFor(installer), null)

  const grok = read('/Users/x/.grok/bin/grok', '/Users/x/.grok/bin/grok-1.0.21')
  assert.equal(grok.channel, 'installer')

  const bare = read('/usr/local/bin/handmade')
  assert.equal(bare.channel, 'path')
  assert.equal(updateCommandFor(bare), null)
  assert.equal(updateCommandFor(bare, { selfUpdate: 'handmade update' }), 'handmade update')
})

test('vendor knowledge overrides what the path guessed', () => {
  const brew = read('/opt/homebrew/bin/gemini', '/opt/homebrew/Cellar/gemini-cli/0.58.0/libexec/bin/gemini')
  assert.equal(brew.packageName, 'gemini-cli')
  assert.equal(updateCommandFor(brew, { brewFormula: 'gemini-cli' }), 'brew upgrade gemini-cli')
  const npm = read('/usr/local/bin/x', '/usr/local/lib/node_modules/x/bin/x')
  assert.equal(updateCommandFor(npm, { npmPackage: '@scope/x' }), 'npm install -g @scope/x@latest')
})

test('every channel has a label', () => {
  for (const channel of ['harnessdesk', 'homebrew', 'npm-global', 'bun', 'uv-tool', 'pipx', 'cargo', 'app-bundle', 'installer', 'path'] as const) {
    assert.ok(channelLabel(channel).length > 0)
  }
})
