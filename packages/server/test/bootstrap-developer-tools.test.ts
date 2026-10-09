import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { tempDir } from './scratch.js'

// Real child processes, synthetic protocols only. Never invokes sandboxed
// git, xcrun or a real agent; selection and installed tools are stubbed.
const LAUNCH = `
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const { createDefaultHost } = await import(process.env.HD_BOOTSTRAP)
const root = process.env.HD_STATE
const capture = (label, fixture) => {
  const file = join(root, label + '.mjs')
  writeFileSync(file, '#!' + process.execPath + '\\n' +
    'import { appendFileSync } from "node:fs";\\n' +
    'appendFileSync(' + JSON.stringify(join(root, 'env.ndjson')) +
    ', JSON.stringify({ label: ' + JSON.stringify(label) +
    ', directory: process.env.DEVELOPER_DIR, serving: process.argv.includes("app-server") }) + "\\\\n");\\n' +
    'await import(' + JSON.stringify(fixture) + ');\\n')
  chmodSync(file, 0o755)
  return file
}
const binary = capture('native', process.env.HD_NATIVE_FIXTURE)
const agents = ['claude-rig', 'cursor-rig', 'gemini-rig', 'explicit-rig'].map(id => ({
  id, name: id, command: process.execPath, args: [capture(id, process.env.HD_ACP_FIXTURE)],
  ...(id === 'explicit-rig' ? { env: { DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' } } : {})
}))
writeFileSync(join(root, 'agents.json'), JSON.stringify({ agents }))
const before = process.env.DEVELOPER_DIR
const { host, extensions, pathReady } = createDefaultHost({
  stateDir: root, codexHome: join(root, 'codex'), codexBinaryPath: binary,
  console: false, logLevel: 'error',
  developerTools: { platform: 'darwin',
    selectedDirectory: () => '/Applications/Xcode.app/Contents/Developer', isDirectory: () => true }
})
try {
  await pathReady
  await host.start()
  // Every child must actually start: launch now warms only the default in
  // the background, while a live operation joins each runtime's startup.
  for (const runtime of ['codex', ...agents.map(agent => agent.id)]) {
    await host.call('session/create', { runtime, options: { cwd: root } })
  }
  if (process.env.DEVELOPER_DIR !== before) throw new Error('host developer directory changed')
} finally {
  await host.dispose()
  await extensions.dispose()
}
`

for (const scenario of [
  { name: 'opt-in', setting: '1', inherited: undefined, expected: '/Library/Developer/CommandLineTools' },
  { name: 'default', setting: undefined, inherited: undefined, expected: undefined },
  { name: 'explicit inherited choice', setting: '1', inherited: '/Applications/Xcode.app/Contents/Developer', expected: '/Applications/Xcode.app/Contents/Developer' },
  { name: 'explicit empty inherited choice', setting: '1', inherited: '', expected: '' },
]) {
  test(`bootstrap preserves host and agent choices in native and ACP children: ${scenario.name}`, { timeout: 60_000 }, async () => {
    const root = tempDir('hd-developer-tools-')
    const env = {
      ...process.env, HOME: tempDir('hd-developer-home-'),
      HARNESSDESK_COMMAND_LINE_TOOLS: scenario.setting, HARNESSDESK_NO_UPDATE_CHECK: '1',
      HD_STATE: root, HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href,
      HD_NATIVE_FIXTURE: new URL('../../../adapter-codex/test/fixtures/fake-codex.mjs', import.meta.url).href,
      HD_ACP_FIXTURE: new URL('../../../adapter-acp/test/fixtures/fake-acp-agent.mjs', import.meta.url).href,
    } as NodeJS.ProcessEnv
    delete env['SHELL']
    if (scenario.inherited === undefined) delete env['DEVELOPER_DIR']
    else env['DEVELOPER_DIR'] = scenario.inherited
    delete env['CODEX_HOME']
    const child = spawn(process.execPath, ['--input-type=module', '-e', LAUNCH], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.stdout.resume()
    const code = await new Promise<number | null>((resolve) => {
      const deadline = setTimeout(() => child.kill('SIGKILL'), 50_000)
      child.once('exit', (value) => { clearTimeout(deadline); resolve(value) })
    })
    assert.equal(code, 0, stderr)
    const seen = readFileSync(join(root, 'env.ndjson'), 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as { label: string; directory?: string; serving: boolean })
    for (const label of ['native', 'claude-rig', 'cursor-rig', 'gemini-rig', 'explicit-rig']) {
      // Binary discovery's --version probe belongs to the host; only the
      // app-server launches the native agent's commands and gets the override.
      const rows = seen.filter(row => row.label === label && (label !== 'native' || row.serving))
      assert.ok(rows.length > 0, `${label} actually started`)
      assert.ok(rows.every(row => row.directory === (label === 'explicit-rig'
        ? '/Applications/Xcode.app/Contents/Developer' : scenario.expected)), label)
    }
  })
}
