import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { runtimeId } from '@harnessdesk/protocol'
import { UsageHistory } from '../src/usage/history.js'
import { tempDir } from './scratch.js'

const one = runtimeId('fake-one'), two = runtimeId('fake-two')
const observation = { lanes: [{ id: 'weekly', label: 'Weekly', usedPercent: 40, windowMinutes: 10080, resetsAt: null }], credits: null, fetchedAt: 1000 }

test('forget fences a writer owned by a different store instance', async () => {
  const path = join(tempDir('hd-history-owners-'), 'history')
  const older = new UsageHistory(path, () => 2000), newer = new UsageHistory(path, () => 2000)
  const token = await older.begin(one)
  await older.write(one, token, observation)
  await newer.forget(one)
  await older.write(one, token, observation)
  assert.equal(await new UsageHistory(path, () => 2000).read(one), null)
})

test('forget without reading a disabled runtime preserves other runtime history', async () => {
  const { writeFile } = await import('node:fs/promises')
  const path = join(tempDir('hd-history-disable-'), 'history')
  const store = new UsageHistory(path, () => 2000)
  await store.write(one, await store.begin(one), observation)
  await store.write(two, await store.begin(two), observation)
  // Invalid prior metadata would fail parsing if disabling tried to read it.
  await writeFile(`${path}.epoch`, 'not JSON')
  await store.forgetWithoutRead(one)
  assert.equal(await store.read(one), null)
  assert.equal((await store.read(two))?.lanes[0]?.usedPercent, 40)
})

test('a stale writer in another process cannot recreate a forgotten reading', async t => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const { pathToFileURL } = await import('node:url')
  const path = join(tempDir('hd-history-process-'), 'history')
  const module = new URL('../src/usage/history.js', import.meta.url)
  const source = `import { UsageHistory } from ${JSON.stringify(pathToFileURL(module.pathname).href)};
    const store = new UsageHistory(process.argv[1], () => 2000), id = 'fake-one';
    const token = await store.begin(id); process.stdout.write('ready\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    await store.write(id, token, ${JSON.stringify(observation)});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, path], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
  const [chunk] = await once(child.stdout, 'data')
  assert.match(String(chunk), /ready/)
  const store = new UsageHistory(path, () => 2000)
  await store.forget(one)
  const closed = once(child, 'close')
  child.stdin.end('continue')
  const [status] = await closed
  assert.equal(status, 0, stderr)
  assert.equal(await store.read(one), null)
})

test('disk uses generic lane names and never stores provider-authored strings', async () => {
  const { readFile, readdir } = await import('node:fs/promises')
  const path = join(tempDir('hd-history-private-'), 'history')
  const store = new UsageHistory(path, () => 2000)
  const sensitive = { lanes: [{ id: 'account-secret-id', label: 'person-secret-name', scope: 'private-scope', resetText: 'private-reset', usedPercent: 40, windowMinutes: 60, resetsAt: 3000 }],
    credits: { unit: 'private-currency', remaining: 8 }, fetchedAt: 1000 }
  await store.write(one, await store.begin(one), sensitive)
  const name = (await readdir(`${path}.d`))[0]!
  const bytes = await readFile(join(`${path}.d`, name), 'utf8')
  assert.doesNotMatch(bytes, /account-secret|person-secret|private-scope|private-reset|private-currency/)
  const saved = await store.read(one)
  assert.equal(saved?.lanes[0]?.label, 'Window 1')
  assert.equal(saved?.lanes[0]?.windowMinutes, 60)
  assert.equal(saved?.credits?.unit, 'units')
})

test('an interrupted owner leaves history unavailable rather than replaying an uncertain forget', async () => {
  const { writeFile } = await import('node:fs/promises')
  const path = join(tempDir('hd-history-lock-'), 'history')
  const store = new UsageHistory(path, () => 2000)
  await store.write(one, await store.begin(one), observation)
  await writeFile(`${path}.lock`, 'interrupted')
  const restarted = new UsageHistory(path, () => 2000)
  assert.equal(await restarted.begin(one), null)
  assert.equal(await restarted.read(one), null)
})

test('flush waits for an in-flight history read to release its lock', { skip: process.platform === 'win32' }, async () => {
  const { execFileSync } = await import('node:child_process')
  const { open, stat } = await import('node:fs/promises')
  const path = join(tempDir('hd-history-flush-'), 'history')
  execFileSync('mkfifo', [`${path}.epoch`])
  const store = new UsageHistory(path)
  const begun = store.begin(one)
  let locked = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await stat(`${path}.lock`); locked = true; break } catch {}
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(locked, true, 'begin owns the lock while its epoch read is blocked')
  let flushed = false
  const flushing = store.flush().then(() => { flushed = true })
  await new Promise(resolve => setImmediate(resolve))
  const returnedBeforeRelease = flushed
  const stillLocked = await stat(`${path}.lock`).then(() => true, () => false)
  const writer = await open(`${path}.epoch`, 'w'); await writer.close()
  await begun; await flushing
  assert.equal(stillLocked, true)
  assert.equal(returnedBeforeRelease, false, 'flush must await the active lock owner')
})
