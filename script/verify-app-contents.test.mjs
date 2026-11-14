import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { APP_INTERFACE, verifyAppContents, verifyAppInterface, verifyAppVersion } from './verify-app-contents.mjs'

const bundle = (t, { ui = true, version = '1.2.3' } = {}) => {
  const top = mkdtempSync(join(tmpdir(), 'hd-app-contents-'))
  t.after(() => rmSync(top, { recursive: true, force: true }))
  const app = join(top, 'HarnessDesk.app')
  mkdirSync(join(app, 'Contents/Resources'), { recursive: true })
  if (ui) {
    mkdirSync(join(app, 'Contents/Resources/ui'))
    writeFileSync(join(app, APP_INTERFACE), '<!doctype html>')
  }
  writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>
`)
  return app
}

test('a bundle without the interface fails, naming the file and pnpm build', (t) => {
  const app = bundle(t, { ui: false })
  assert.throws(() => verifyAppInterface(app), /Contents\/Resources\/ui\/index\.html is missing.*pnpm build/)
  assert.throws(() => verifyAppContents(app, '1.2.3', { readVersion: () => '1.2.3' }), /carries no interface/)
})

test('a version that does not match the package fails, naming both', (t) => {
  const app = bundle(t)
  assert.throws(() => verifyAppVersion(app, '1.2.4', { readVersion: () => '1.2.3' }), /version 1\.2\.3, but packages\/desktop\/package\.json says 1\.2\.4/)
})

test('an unreadable Info.plist fails rather than passing', (t) => {
  const app = bundle(t)
  assert.throws(() => verifyAppVersion(app, '1.2.3', { readVersion: () => { throw new Error('no key') } }), /no readable CFBundleShortVersionString/)
})

test('a complete bundle of the right version passes, reading Info.plist with plutil', { skip: spawnSync('plutil', ['-help']).error ? 'plutil is macOS only' : false }, (t) => {
  const app = bundle(t, { version: '1.2.3' })
  verifyAppContents(app, '1.2.3')
  assert.throws(() => verifyAppContents(app, '9.9.9'), /version 1\.2\.3/)
})
