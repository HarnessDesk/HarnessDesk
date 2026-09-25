import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { startStaticServer } from './shots/static-server.mjs'

test('serves a file inside its root over loopback, on an ephemeral port', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hd-static-server-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), '<h1>hello</h1>')

  const server = await startStaticServer(root)
  t.after(() => server.close())

  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'the address must be loopback, not the real interface')
  assert.notEqual(new URL(server.url).port, '0', 'an ephemeral port must have actually been assigned')

  const response = await fetch(`${server.url}/index.html`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await response.text(), '<h1>hello</h1>')
})

test('never reads outside the root it was given, whatever the request path says', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'hd-static-server-escape-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  writeFileSync(join(parent, 'secret.txt'), 'must not be servable')
  const root = join(parent, 'served')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'index.html'), 'ok')

  const server = await startStaticServer(root)
  t.after(() => server.close())

  for (const attempt of ['../secret.txt', '..%2Fsecret.txt', '..\\secret.txt']) {
    const response = await fetch(`${server.url}/${attempt}`)
    assert.notEqual(response.status, 200, `${attempt} must not be servable`)
    const body = await response.text()
    assert.doesNotMatch(body, /must not be servable/)
  }
})

test('answers 404 for a file that does not exist, rather than throwing', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hd-static-server-missing-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const server = await startStaticServer(root)
  t.after(() => server.close())

  const response = await fetch(`${server.url}/nothing-here.html`)
  assert.equal(response.status, 404)
})

test('close() actually stops the server from accepting new connections', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hd-static-server-close-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'index.html'), 'ok')

  const server = await startStaticServer(root)
  const { url } = server
  await server.close()

  await assert.rejects(fetch(`${url}/index.html`), 'a closed server must refuse new requests')
})
