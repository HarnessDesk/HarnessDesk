import assert from 'node:assert/strict'
import test from 'node:test'

import { isPng, runDeviceForPng } from '../src/device-exec.js'

const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

test('isPng recognizes valid 8-byte PNG header and rejects others', () => {
  assert.equal(isPng(PNG_BUFFER), true)
  assert.equal(isPng(Buffer.from('PNG')), false)
  assert.equal(isPng(Buffer.from([])), false)
  assert.equal(isPng(Buffer.from('not a png image at all')), false)
})

test('runDeviceForPng rejects non-PNG stdout even on exit code 0', async () => {
  await assert.rejects(
    runDeviceForPng(process.execPath, ['-e', "process.stdout.write('daemon starting up')"], {
      what: 'Screenshotting',
    }),
    /Screenshotting produced non-PNG output\./,
  )
})

test('runDeviceForPng includes stderr details on failure', async () => {
  await assert.rejects(
    runDeviceForPng(
      process.execPath,
      ['-e', "process.stderr.write('adb: error: device offline\\n'); process.exit(1)"],
      { what: 'Screenshotting' },
    ),
    /Screenshotting failed: adb: error: device offline/,
  )
})

test('runDeviceForPng returns data url for valid png stdout', async () => {
  const result = await runDeviceForPng(
    process.execPath,
    ['-e', "process.stdout.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))"],
    { what: 'Screenshotting' },
  )
  assert.equal(result, `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`)
})
