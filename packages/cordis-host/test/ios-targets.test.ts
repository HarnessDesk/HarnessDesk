import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import test from 'node:test'
import { iosService, PNG } from './fixtures/ios.js'

const fixture = (png = PNG) => {
  const calls: string[][] = []
  let appearance = 'light'
  const service = iosService({ run: async (binary: string, args: readonly string[]) => {
    calls.push([binary, ...args])
    if (args[1] === 'list') return { stdout: JSON.stringify({ devices: { 'iOS-27': ['A', 'B'].map((udid) => ({ udid, name: `iPhone ${udid}`, state: 'Booted' })) } }), stderr: '' }
    if (args[1] === 'io') writeFileSync(args[4]!, png)
    if (args[1] === 'ui' && args.length === 5) appearance = args[4]!
    return { stdout: args[1] === 'ui' ? appearance : '', stderr: '' }
  } })
  return { service, calls }
}

test('refuses ambiguous booted devices', async () => {
  const { service } = fixture()
  await assert.rejects(service.booted(), /more than one.*A.*B/i)
  await assert.rejects(service.booted('missing'), /missing.*not booted/i)
})

test('explicit target is used by action and screenshot', async () => {
  const { service, calls } = fixture()
  await service.install('/tmp/Example.app', 'B')
  await service.launch('com.example.App', 'B')
  await service.terminate('com.example.App', 'B')
  await service.openUrl('https://example.com', 'B')
  const frame = await service.frame('B')
  assert.equal(frame.udid, 'B')
  assert.equal(frame.width, 1)
  assert.equal(frame.height, 1)
  assert.equal(frame.mimeType, 'image/png')
  assert.ok(frame.frameId)
  assert.equal(frame.url, `data:image/png;base64,${PNG.toString('base64')}`)
  assert.equal(await service.screenshot('B'), frame.url)
  const actions = calls.filter((call) => call[2] !== 'list')
  assert.deepEqual(actions.map((call) => [call[2], call[3]]), [['install', 'B'], ['launch', 'B'], ['terminate', 'B'], ['openurl', 'B'], ['io', 'B'], ['io', 'B']])
  assert.ok(!calls.some((call) => call.includes('booted')))
})

test('headless boot does not invoke open', async () => {
  const { service, calls } = fixture()
  await service.boot('B', { openWindow: false })
  assert.deepEqual(calls, [['xcrun', 'simctl', 'list', 'devices', '-j'], ['xcrun', 'simctl', 'boot', 'B']])
  await service.boot('B')
  assert.deepEqual(calls.at(-1), ['open', '-a', 'Simulator'])
})

test('invalid screenshot dimensions are refused', async () => {
  for (const png of [Buffer.from('PNG'), Buffer.alloc(24), (() => { const broken = Buffer.from(PNG); broken.writeUInt32BE(0, 16); return broken })()]) {
    await assert.rejects(fixture(png).service.frame('B'), /screenshot.*(PNG|dimensions)/i)
  }
})

test('appearance uses native command forms and reads back after setting', async () => {
  const { service, calls } = fixture()
  assert.equal(await service.getAppearance('B'), 'light')
  assert.equal(await service.setAppearance('dark', 'B'), 'dark')
  assert.deepEqual(calls.filter((call) => call[2] === 'ui'), [
    ['xcrun', 'simctl', 'ui', 'B', 'appearance'],
    ['xcrun', 'simctl', 'ui', 'B', 'appearance', 'dark'],
    ['xcrun', 'simctl', 'ui', 'B', 'appearance'],
  ])
})

test('appearance preserves unsupported and unknown results', async () => {
  for (const expected of ['unsupported', 'unknown']) {
    const service = iosService({ run: async (_binary: string, args: readonly string[]) => {
      if (args[1] === 'list') return { stdout: '{"devices":{"iOS":[{"udid":"B","state":"Booted"}]}}', stderr: '' }
      if (expected === 'unsupported') throw new Error('appearance is not supported on this device')
      return { stdout: 'unexpected state', stderr: '' }
    } })
    assert.equal(await service.getAppearance('B'), expected)
    assert.equal(await service.setAppearance('dark', 'B'), expected)
  }
})

test('manifest-denied calls execute no subprocess', async () => {
  let calls = 0
  const service = iosService({ run: async () => { calls++; throw new Error('unexpected subprocess') }, environment: { exists: () => { calls++; return true }, execute: async () => { calls++; throw new Error('unexpected probe') } } }, true)
  const operations = [() => service.diagnose(), () => service.devices(), () => service.booted(), () => service.boot('B'), () => service.install('/tmp/Example.app'), () => service.launch('com.example.App'), () => service.terminate('com.example.App'), () => service.openUrl('https://example.com'), () => service.screenshot(), () => service.frame(), () => service.tap(0, 0), () => service.getAppearance(), () => service.setAppearance('dark')]
  for (const operation of operations) await assert.rejects(operation, /ios permission denied/)
  assert.equal(calls, 0)
})

test('frame identity cannot be reused by a later capture of identical pixels', async () => {
  const { service } = fixture()
  const first = await service.frame('B')
  const next = await service.frame('B')
  assert.notEqual(first.frameId, next.frameId, 'an unobserved shutdown and reboot must not reuse a frame identity')
})

test('boot requires an exact device udid rather than a selector or name', async () => {
  const { service, calls } = fixture()
  for (const udid of ['--help', 'booted', 'iPhone A', '00000000-0000-0000-0000-000000000000']) {
    await assert.rejects(service.boot(udid, { openWindow: false }), /udid.*ios_devices/i)
  }
  assert.ok(calls.every((call) => call[2] === 'list'), 'invalid targets never reach simctl boot or open')
})

test('bundle ids beginning with a dash are refused before simctl runs', async () => {
  const { service, calls } = fixture()
  await assert.rejects(service.launch('--help', 'B'), /bundle.*begin.*-/i)
  await assert.rejects(service.terminate('--help', 'B'), /bundle.*begin.*-/i)
  assert.deepEqual(calls, [])
})

test('headless tap uses its explicit target with multiple simulators booted', async () => {
  let tapped = ''
  const service = iosService({ run: async (_binary, args) => {
    if (args[1] === 'list') return { stdout: JSON.stringify({ devices: { iOS: ['A','B'].map(udid => ({ udid, name: 'Fixture', state: 'Booted' })) } }), stderr: '' }
    if (args[1] === 'io') writeFileSync(args[4]!, PNG)
    return { stdout: '', stderr: '' }
  }, input: { request: async (udid) => { tapped = udid; return {} } } })
  await service.tap(0, 0, 'B')
  assert.equal(tapped, 'B')
  await assert.rejects(service.tap(0, 0), /more than one.*booted/i)
})
