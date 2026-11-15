import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { scratch } from './scratch.js'

const fake = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))

for (const [name, account] of [
  ['default account', undefined],
  ['configured account', { email: 'dev@example.com', subscriptionType: 'max', apiProvider: 'firstParty' }],
] as const) {
  test(`the fake CLI's auth status reports its ${name} and exits`, async () => {
    const home = scratch('fake-auth-home-'), log = join(scratch('fake-auth-log-'), 'processes.log')
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: scratch('fake-auth-config-'), FAKE_CLAUDE_LOG: log }
    if (account) env.FAKE_CLAUDE_ACCOUNT = JSON.stringify(account)
    else delete env.FAKE_CLAUDE_ACCOUNT
    const { stdout, pid, killed, exitCode, signalCode } = await new Promise<{ stdout: string; pid: number; killed: boolean; exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolve, reject) => {
      const child = execFile(fake, ['auth', 'status', '--json'], { cwd: home, env, timeout: 5_000 }, (error, stdout) => {
        if (error) reject(error)
        else if (child.pid === undefined) reject(new Error('The fake auth process did not start.'))
        else resolve({ stdout, pid: child.pid, killed: child.killed, exitCode: child.exitCode, signalCode: child.signalCode })
      })
    })
    assert.equal(killed, false, 'the auth process must exit without a timeout signal')
    assert.equal(exitCode, 0)
    assert.equal(signalCode, null)
    const status = JSON.parse(stdout) as { loggedIn: boolean; email: string; subscriptionType: string; apiProvider?: string }
    assert.equal(status.loggedIn, true)
    assert.equal(status.email, account?.email ?? 'fake@example.com')
    assert.equal(status.subscriptionType, account?.subscriptionType ?? 'fake')
    if (account) assert.equal(status.apiProvider, account.apiProvider)
    const lines = (await readFile(log, 'utf8')).split('\n')
    assert.ok(lines.some(line => line.startsWith(`spawn ${pid} `)))
    assert.ok(lines.includes(`exit ${pid}`))
  })
}
