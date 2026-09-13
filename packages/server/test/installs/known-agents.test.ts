import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { AgentRegistryStore } from '../../src/agent-registry.js'
import { readChannel, updateCommandFor } from '../../src/installs/channels.js'
import { knownAgent, knownAgentByCommand } from '../../src/installs/known-agents.js'
import { findInstalls } from '../../src/installs/locate.js'
import { InstallService } from '../../src/installs/service.js'

/**
 * GitHub Copilot, the eleventh agent the desk knows about.
 *
 * Everything here was read off the vendor's own CLI on 2026-09-12 — the ACP
 * handshake, the version sentence, the Homebrew cask, the home, the sign-in
 * — and these hold the entry to what was read, because the whole value of
 * the table is that a fact in it came from the machine rather than from a
 * description of the machine.
 *
 * The three that would have been wrong without measuring: `copilot --acp` is
 * the launch (the registry's row is an `npx` line that fetches a second copy
 * of a CLI already installed), the version is printed as a sentence with a
 * prerelease suffix rather than as a triple, and the Homebrew token is the
 * *cask* `copilot-cli` — `brew upgrade copilot` names AWS's deprecated ECS
 * tool instead.
 */

const HOME = '/Users/x'
const STATE = '/Users/x/.harnessdesk'
/** The cask links its Binary artifact into the prefix's bin. */
const BIN = '/opt/homebrew/bin/copilot'
const CASK = '/opt/homebrew/Caskroom/copilot-cli/1.0.83/copilot'
/** A second copy by the other road, so the choice between them is a real one. */
const NPM_BIN = '/Users/x/.local/bin/copilot'
const NPM_FILE = '/Users/x/.npm-global/lib/node_modules/@github/copilot/npm-loader.js'

const tempStore = async (t: { after(fn: () => void): void }, entries: Record<string, unknown>[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-copilot-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new AgentRegistryStore(join(dir, 'agents.json'))
  for (const entry of entries) store.add(entry as Record<string, unknown> & { id: string })
  return store
}

/** A machine: which paths exist, where each link points, and what each prints. */
const machine = (files: Record<string, string | null>, links: Record<string, string> = {}) => ({
  env: { PATH: '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin' },
  home: HOME,
  platform: 'darwin' as const,
  exists: (path: string) => path in files,
  realpath: (path: string) => links[path] ?? path,
  probe: async (path: string) => files[links[path] ?? path] ?? files[path] ?? null,
})

test("the installed copy answers, and the registry's npx line becomes the fallback", async (t) => {
  const store = await tempStore(t, [
    // What `agents/register` writes for this entry: the registry distributes
    // Copilot as an npx package, so with no knowledge of the agent the desk
    // fetched a second copy of a CLI already on the machine on every start.
    {
      id: 'github-copilot-cli',
      name: 'GitHub Copilot',
      command: 'npx',
      args: ['-y', '@github/copilot@1.0.83', '--acp'],
      agent: 'github-copilot-cli',
      registry: { id: 'github-copilot-cli', version: '1.0.83' },
    },
  ])
  const service = new InstallService({
    stateDir: STATE,
    store,
    now: () => 1000,
    locate: machine(
      {
        [BIN]: 'GitHub Copilot CLI 1.0.84-5.',
        [CASK]: 'GitHub Copilot CLI 1.0.84-5.',
        [NPM_BIN]: 'GitHub Copilot CLI 1.0.80.',
        [NPM_FILE]: 'GitHub Copilot CLI 1.0.80.',
      },
      { [BIN]: CASK, [NPM_BIN]: NPM_FILE },
    ),
  })
  const config = store.configs()[0]!

  assert.deepEqual(await service.launchFor(config), {
    command: BIN,
    args: ['--acp'],
    version: '1.0.84-5',
  })

  const info = await service.describe(config)
  assert.ok(info)
  assert.equal(info.chosen?.path, BIN)
  assert.equal(info.chosen?.channelLabel, 'Homebrew')
  // The cask, spelled as a cask: see the entry, and `readChannel`.
  assert.equal(info.chosen?.updateCommand, 'brew upgrade --cask copilot-cli')
  assert.deepEqual(
    info.copies.map((copy) => [copy.version, copy.standing, copy.channelLabel, copy.updateCommand]),
    [
      ['1.0.84-5', 'chosen', 'Homebrew', 'brew upgrade --cask copilot-cli'],
      ['1.0.80', 'older', 'npm', 'npm install -g @github/copilot@latest'],
    ],
  )
  // Still recorded, still runnable, and no longer what runs.
  assert.deepEqual(info.fallback, {
    command: 'npx -y @github/copilot@1.0.83 --acp',
    version: '1.0.83',
    managed: true,
  })
  assert.equal(info.home?.path, '~/.copilot')
  assert.equal(info.home?.env, 'COPILOT_HOME')
  assert.equal(info.signIn?.terminal, 'copilot login')
  assert.equal(info.installCommand, 'npm install -g @github/copilot')
})

test('`copilot --version` prints a sentence, and the release is read out of it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-copilot-bin-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bin = join(dir, 'copilot')
  // Verbatim what /opt/homebrew/bin/copilot printed on 2026-09-12, both lines
  // on stdout: no triple on its own, a prerelease suffix on the one there is,
  // and a second line that is prose.
  await writeFile(
    bin,
    ["#!/bin/sh", "echo 'GitHub Copilot CLI 1.0.84-5.'", `echo "Run 'copilot update' to check for updates."`, ''].join('\n'),
  )
  await chmod(bin, 0o755)

  const known = knownAgent('github-copilot-cli')
  assert.ok(known)
  // No injected probe: this runs the binary the way a real scan does.
  const found = await findInstalls(
    {
      commands: known.cli.commands,
      ...(known.cli.versionArgs ? { versionArgs: known.cli.versionArgs } : {}),
    },
    { env: { PATH: dir }, home: dir, platform: 'darwin' },
  )
  assert.equal(found.length, 1)
  assert.equal(found[0]?.version, '1.0.84-5')
})

test('the Homebrew road names the cask, never the `copilot` formula', () => {
  const known = knownAgent('github-copilot-cli')
  assert.ok(known)
  // A row that names only the command still finds this entry.
  assert.equal(knownAgentByCommand('copilot'), known)
  assert.deepEqual([...known.acp.args], ['--acp'])
  assert.equal(known.acp.bridge, undefined, 'the CLI speaks ACP itself')
  assert.equal(known.publish.brew, 'copilot-cli')
  assert.equal(known.publish.selfUpdate, 'copilot update')
  assert.equal(
    updateCommandFor(readChannel(BIN, { home: HOME, platform: 'darwin', realpath: () => CASK }), {
      brewFormula: known.publish.brew ?? null,
    }),
    'brew upgrade --cask copilot-cli',
  )
})
