import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadAccountPicture } from '../src/account-picture.js'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jYVQAAAAASUVORK5CYII=', 'base64')
const publicAddress = { address: '93.184.216.34', family: 4 }
test('pictures use a pinned public HTTPS address and a bounded raster data URI', async () => {
  let called = false
  const result = await loadAccountPicture('https://images.example.com/jane.png', {
    lookup: async () => [publicAddress], request: async (_url, address) => { assert.deepEqual(address, publicAddress); called = true; return { type: 'image/png', bytes: png } },
  })
  assert.equal(called, true); assert.equal(result, `data:image/png;base64,${png.toString('base64')}`)
})
test('picture requests refuse private, mixed DNS, credentials and nonstandard origins', async () => {
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '169.254.169.254', family: 4 }], [{ address: '::1', family: 6 }], [{ address: '::ffff:127.0.0.1', family: 6 }], [publicAddress, { address: '10.0.0.1', family: 4 }]]) {
    let called = false
    assert.equal(await loadAccountPicture('https://images.example.com/jane.png', { lookup: async () => addresses, request: async () => { called = true; return { type: 'image/png', bytes: png } } }), undefined)
    assert.equal(called, false)
  }
  for (const url of ['http://images.example.com/jane.png', 'https://name:secret@images.example.com/jane.png', 'https://images.example.com:8443/jane.png', 'data:image/png;base64,AA==']) {
    let called = false
    assert.equal(await loadAccountPicture(url, { lookup: async () => { called = true; return [publicAddress] } }), undefined)
    assert.equal(called, false)
  }
})
test('SVG, oversized images and a raster MIME hiding markup are refused', async () => {
  for (const response of [{ type: 'image/svg+xml', bytes: Buffer.from('<svg/>') }, { type: 'image/png', bytes: Buffer.from('<svg/>') }, { type: 'image/png', bytes: Buffer.alloc(256 * 1024 + 1) }]) {
    assert.equal(await loadAccountPicture('https://images.example.com/jane.png', { lookup: async () => [publicAddress], request: async () => response }), undefined)
  }
})
