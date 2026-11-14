import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

import { checkExtraResources } from './before-pack.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** A stand-in repository: `packages/desktop` as the base, with every source the manifest names filled in. */
const repo = (t) => {
  const top = mkdtempSync(join(tmpdir(), 'hd-before-pack-'))
  t.after(() => rmSync(top, { recursive: true, force: true }))
  const base = join(top, 'packages/desktop')
  const fill = (relative, file = 'present') => {
    const path = join(base, relative, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'x')
  }
  // Each source holds what its filter names, or one file when it has none.
  for (const entry of manifest.build.extraResources) {
    for (const file of entry.filter ?? ['present']) fill(entry.from.replaceAll('${arch}', 'arm64'), file)
  }
  fill('../ui/dist', 'index.html')
  return { base, fill }
}

test('every extraResources source of the real manifest is checked, with ${arch} substituted', (t) => {
  const { base } = repo(t)
  const checked = checkExtraResources({ entries: manifest.build.extraResources, arch: 'arm64', base })
  assert.equal(checked.length, manifest.build.extraResources.length)
  assert.ok(checked.some((path) => path.endsWith(join('.lead-node', 'arm64'))))
  assert.ok(checked.some((path) => path.endsWith(join('native', 'darwin-arm64'))))
  assert.ok(checked.every((path) => !path.includes('${arch}')))
})

test('a missing UI build refuses the pack and says to run pnpm build', (t) => {
  const { base } = repo(t)
  rmSync(join(base, '../ui/dist'), { recursive: true })
  assert.throws(
    () => checkExtraResources({ entries: manifest.build.extraResources, arch: 'arm64', base }),
    (error) => /"\.\.\/ui\/dist"/.test(error.message) && /does not exist/.test(error.message) && /run `pnpm build` from the repository root/.test(error.message),
  )
})

test('a UI folder without index.html refuses the pack even though it is not empty', (t) => {
  const { base } = repo(t)
  rmSync(join(base, '../ui/dist/index.html'))
  assert.throws(
    () => checkExtraResources({ entries: manifest.build.extraResources, arch: 'arm64', base }),
    /ui[/\\]dist[/\\]index\.html is missing.*build:node` alone does not build the UI/,
  )
})

test('an empty source directory refuses the pack, naming the entry', (t) => {
  const { base } = repo(t)
  rmSync(join(base, '../../assets/avatars/384'), { recursive: true })
  mkdirSync(join(base, '../../assets/avatars/384'))
  assert.throws(
    () => checkExtraResources({ entries: manifest.build.extraResources, arch: 'arm64', base }),
    /"\.\.\/\.\.\/assets\/avatars\/384" \(.*\) is an empty directory/,
  )
})

test('the other architecture is checked on its own: x64 sources are not satisfied by arm64 ones', (t) => {
  const { base } = repo(t)
  assert.throws(
    () => checkExtraResources({ entries: manifest.build.extraResources, arch: 'x64', base }),
    (error) => /Refusing to pack x64/.test(error.message) && /\.lead-node\/\$\{arch\}/.test(error.message) && /darwin-\$\{arch\}/.test(error.message),
  )
})

test('a filtered source that holds none of its literal filter paths refuses the pack', (t) => {
  const { base, fill } = repo(t)
  // The real iOS helper entry: its folder is not empty, but hd-ios-control is not in it.
  const helper = manifest.build.extraResources.find((entry) => entry.to === 'native/ios')
  assert.ok(helper.filter.includes('hd-ios-control'))
  const folder = join(base, '../cordis-host/dist/native/darwin-arm64')
  rmSync(join(folder, 'hd-ios-control'))
  fill('../cordis-host/dist/native/darwin-arm64', 'hd-ios-control.dSYM')
  assert.throws(
    () => checkExtraResources({ entries: [helper], arch: 'arm64', base }),
    /darwin-\$\{arch\}" \(.*\) holds none of its filter's files: hd-ios-control/,
  )
  fill('../cordis-host/dist/native/darwin-arm64', 'hd-ios-control')
  checkExtraResources({ entries: [helper], arch: 'arm64', base })
})

test('one literal filter path present is enough, and globs and negations are not checked', (t) => {
  const { base, fill } = repo(t)
  fill('lead/arm64/bin', 'node')
  checkExtraResources({ entries: [{ from: 'lead/${arch}', to: 'x', filter: ['bin/node', 'LICENSE'] }], arch: 'arm64', base })
  fill('globbed', 'other.txt')
  checkExtraResources({ entries: [{ from: 'globbed', to: 'x', filter: ['**/*.png', '!secret'] }], arch: 'arm64', base })
})

test('a string entry and an entry without from are handled', (t) => {
  const { base, fill } = repo(t)
  fill('plain')
  assert.deepEqual(checkExtraResources({ entries: ['plain'], arch: 'arm64', base }), [join(base, 'plain')])
  assert.throws(() => checkExtraResources({ entries: [{ to: 'x' }], arch: 'arm64', base }), /has no "from"/)
})

test('electron-builder runs the resource check: it is the last step of beforePack', () => {
  const hook = readFileSync(new URL('./before-pack.mjs', import.meta.url), 'utf8')
  const body = hook.slice(hook.indexOf('export const beforePack'))
  assert.ok(body.indexOf('checkExtraResources(') > body.indexOf('await prepareLead(context)'),
    'the Lead runtime is fetched first, so its folder counts as present')
})
