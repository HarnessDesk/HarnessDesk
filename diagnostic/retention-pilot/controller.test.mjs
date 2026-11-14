import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const fixture = fileURLToPath(new URL('./fake-codex-1545.mjs', import.meta.url))
test('fake profile rejects external URLs and unsafe control paths', () => {
  const text = readFileSync(fixture, 'utf8')
  assert.doesNotMatch(text, /https?:\/\/(?!127\.0\.0\.1:1)/)
  assert.match(text, /case 'command\/exec':\s*\{\s*send\(\{ id, error:/)
  assert.match(text, /said\.startsWith\('git-steer-run '\)\) \{ send\(\{ id, error:/)
  const result = spawnSync(process.execPath, [fixture, '--version'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /0\.149\.0/)
})
test('pilot refuses to launch outside a hosted macOS runner', () => {
  if (process.platform === 'darwin' && process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') return
  const controller = fileURLToPath(new URL('./controller.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [controller], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 5000 })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /hosted macOS runner required/)
})
