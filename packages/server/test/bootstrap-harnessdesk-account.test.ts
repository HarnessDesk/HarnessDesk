import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { test } from 'node:test'

// Exercise the production bootstrap, not only Host's constructor options.
// Every home is throwaway; no runtime is started and all cloud requests are scripted.
const script = `
import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { join } from 'node:path'
const { createDefaultHost } = await import(process.env.HD_BOOTSTRAP)
const key = randomBytes(32)
const cipher = {
  protection: 'Test keystore',
  encrypt(text) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, c.update(text), c.final(), c.getAuthTag()]) },
  decrypt(blob) { const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12)); d.setAuthTag(blob.subarray(-16)); return Buffer.concat([d.update(blob.subarray(12, -16)), d.final()]).toString() },
}
let opened = ''
globalThis.fetch = async (input) => {
  const url = new URL(String(input))
  assert.equal(url.origin, 'https://cloud.example.com')
  if (url.pathname === '/v1/desk/challenge') return Response.json({challenge:'A'.repeat(43),expiresAt:Math.floor(Date.now()/1000)+60})
  assert.equal(url.pathname, '/v1/desk-link/start')
  return Response.json({userCode:'ABCD-EFGH',pollSecret:'p'.repeat(43),verifyUrl:'https://cloud.example.com/link#code=ABCD-EFGH',expiresAt:Math.floor(Date.now()/1000)+600,intervalSeconds:30})
}
const bootstrap = createDefaultHost({ stateDir: process.env.HD_STATE, codexHome: join(process.env.HD_STATE, 'codex'), codexBinaryPath: null, console: false,
  credentialCipher: cipher, accountCloudUrl: 'https://cloud.example.com', accountOpenExternal: async url => { opened = url } })
try {
  await bootstrap.pathReady
  const pending = await bootstrap.host.call('account/signIn', {})
  assert.equal(pending.status, 'pending')
  assert.equal(pending.pending.userCode, 'ABCD-EFGH')
  assert.equal(opened, 'https://cloud.example.com/link#code=ABCD-EFGH')
  assert.equal((await bootstrap.host.call('account/cancel', {})).status, 'signedOut')
} finally { await bootstrap.host.dispose() }
`
test('desktop bootstrap forwards account browser and cloud configuration into the host', { timeout: 15_000 }, async t => {
  await mkdir('scratch/desktop-sign-in', { recursive: true })
  const root = resolve(await mkdtemp('scratch/desktop-sign-in/bootstrap-account-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profile = join(root, 'profile'); await mkdir(profile)
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: profile, HARNESSDESK_HOME: join(root, 'desk'), HARNESSDESK_NO_UPDATE_CHECK: '1',
    HD_STATE: join(root, 'desk'), HD_BOOTSTRAP: new URL('../src/bootstrap.js', import.meta.url).href }
  delete env['SHELL']; delete env['CODEX_HOME']; delete env['HARNESSDESK_CLOUD_URL']
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let error = ''; child.stdout.resume(); child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString() })
  const code = await new Promise<number | null>(resolve => {
    const deadline = setTimeout(() => child.kill('SIGKILL'), 12_000)
    child.on('exit', code => { clearTimeout(deadline); resolve(code) })
  })
  assert.equal(code, 0, error)
})
