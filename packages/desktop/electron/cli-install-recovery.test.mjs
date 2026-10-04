import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { constants, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import * as paths from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

// Execute the real module against a filesystem whose syscall boundaries we
// control. No timing sleeps, native UI, or writes to a person's filesystem.
const source = readFileSync(new URL('./cli-install.mjs', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+'\n/gm, '')
  .replace(/^export /gm, '')
const FIXTURE_HOME = '/home/jane'
const LAUNCHER_PATH = `${FIXTURE_HOME}/.local/bin/harnessdesk`
const fail = (code) => Object.assign(new Error(`injected ${code}`), { code })

const rig = () => {
  const files = new Map()
  const descriptors = new Map()
  let next = 1
  let fault = () => {}
  const put = (path, text, kind = 'file') => files.set(path, { text, kind, ino: BigInt(next++), dev: 1n })
  const get = (path) => {
    const file = files.get(path)
    if (!file) throw fail('ENOENT')
    return file
  }
  const stat = (file) => ({
    ...file, size: BigInt(Buffer.byteLength(file.text)),
    isFile: () => file.kind === 'file', isDirectory: () => file.kind === 'folder',
  })
  const fs = {
    constants,
    openSync(path) {
      fault('open', path)
      const file = get(path)
      if (file.kind === 'link') throw fail('ELOOP')
      const fd = next++
      descriptors.set(fd, { path, file, position: 0 })
      return fd
    },
    fstatSync(fd) { const d = descriptors.get(fd); fault('stat', d.path); return stat(d.file) },
    readSync(fd, buffer, offset, length) {
      const d = descriptors.get(fd)
      fault('read', d.path)
      const bytes = Buffer.from(d.file.text)
      const count = bytes.copy(buffer, offset, d.position, d.position + length)
      d.position += count
      return count
    },
    closeSync(fd) { const d = descriptors.get(fd); descriptors.delete(fd); fault('close', d.path) },
    lstatSync(path) { fault('lstat', path); return stat(get(path)) },
    renameSync(from, to) { fault('rename', to); files.set(to, get(from)); files.delete(from) },
    linkSync(from, to) {
      fault('link', to)
      if (files.has(to)) throw fail('EEXIST')
      files.set(to, get(from))
    },
    unlinkSync(path) { fault('unlink', path); get(path); files.delete(path) },
    writeFileSync(path, bytes, options) {
      fault('write', path)
      if (options?.flag === 'wx' && files.has(path)) throw fail('EEXIST')
      put(path, String(bytes))
    },
    chmodSync() {},
    readFileSync: (path) => Buffer.from(get(path).text),
    existsSync: (path) => files.has(path),
  }
  const sandbox = { ...paths, ...fs, randomUUID, homedir, Buffer, process }
  runInNewContext(`${source}\nglobalThis.api = { removeLauncher, replaceLauncher, createCommandLineTool, launcherText };`, sandbox)
  const api = sandbox.api
  const text = api.launcherText({ runtime: '/Applications/HarnessDesk.app/runtime', entry: '/Applications/HarnessDesk.app/bin.js' })
  put(LAUNCHER_PATH, text)
  return { ...api, files, put, text, faults: (fn) => { fault = fn } }
}

test('restore never renames over a newcomer, including when hard links are unavailable', () => {
  for (const kind of ['file', 'link', 'folder']) {
    const r = rig()
    let newcomer
    r.faults((step, path) => {
      if (step === 'link') throw fail('ENOTSUP')
      if (step === 'lstat' && path === LAUNCHER_PATH) {
        // The old fallback sees ENOENT, but somebody takes the name before rename.
        r.put(LAUNCHER_PATH, 'newcomer')
        newcomer = r.files.get(LAUNCHER_PATH)
        throw fail('ENOENT')
      }
      if (step === 'rename' && path === LAUNCHER_PATH && !newcomer) {
        r.put(LAUNCHER_PATH, 'newcomer')
        newcomer = r.files.get(LAUNCHER_PATH)
      }
    })
    let result
    try {
      r.removeLauncher({ home: FIXTURE_HOME, hooks: { afterCheck: () => r.put(LAUNCHER_PATH, 'foreign', kind) } })
    } catch (error) { result = error }
    if (newcomer) assert.equal(r.files.get(LAUNCHER_PATH), newcomer, 'the newcomer survives by identity and contents')
    assert.ok(result?.held, 'a restoration that cannot be atomic names the retained file')
    assert.equal(r.files.get(result.held).text, 'foreign')
  }
})

for (const action of ['remove', 'replace']) {
  for (const step of ['afterClaim', 'open', 'stat', 'read', 'close', ...(action === 'remove' ? ['unlink'] : ['place'])]) {
    test(`a failure at ${step} after ${action} claims the file restores the launcher and returns structured recovery`, () => {
      const r = rig()
      r.faults((at, path) => {
        if (step === 'place' && at === 'link' && path === LAUNCHER_PATH) {
          r.faults((next, name) => {
            if (next === 'write' && name === LAUNCHER_PATH) { r.faults(() => {}); throw fail('EIO') }
          })
          throw fail('EIO')
        }
        if (at === step && path.endsWith('.held')) {
          r.faults(() => {})
          throw fail('EIO')
        }
      })
      const hooks = { afterClaim: () => { if (step === 'afterClaim') throw fail('EIO') } }
      assert.throws(() => action === 'remove'
        ? r.removeLauncher({ home: FIXTURE_HOME, hooks })
        : r.replaceLauncher(LAUNCHER_PATH, 'replacement', { hooks }),
      (error) => error.code === 'recovery' && error.path === LAUNCHER_PATH && error.restored === true && !error.held)
      assert.equal(r.files.get(LAUNCHER_PATH)?.text, r.text, 'the command is restored')
      assert.equal(r.files.size, 1, 'no held file is stranded')
    })
  }
}

test('when inspection and restoration fail, the structured error names the held launcher', () => {
  const r = rig()
  r.faults((step, path) => {
    if (step === 'open' && path.endsWith('.held')) throw fail('EIO')
    if (step === 'lstat' && path.endsWith('.held')) throw fail('EACCES')
  })
  assert.throws(() => r.removeLauncher({ home: FIXTURE_HOME }), (error) => {
    assert.equal(error.code, 'recovery')
    assert.equal(error.path, LAUNCHER_PATH)
    assert.equal(error.restored, false)
    assert.equal(r.files.get(error.held)?.text, r.text)
    return true
  })
})

test('replacement cleanup failures retain and name the old launcher beside its replacement', () => {
  const r = rig()
  r.faults((at, path) => { if (at === 'unlink' && path.endsWith('.held')) throw fail('EIO') })
  assert.throws(() => r.replaceLauncher(LAUNCHER_PATH, 'replacement'), (error) => {
    assert.equal(error.code, 'recovery')
    assert.equal(error.restored, false)
    assert.equal(r.files.get(error.held)?.text, r.text)
    assert.equal(r.files.get(LAUNCHER_PATH)?.text, 'replacement')
    return true
  })
})

test('replacement cleanup failures also name the held launcher when a newcomer took its name', () => {
  const r = rig()
  r.faults((at, path) => { if (at === 'unlink' && path.endsWith('.held')) throw fail('EIO') })
  assert.throws(() => r.replaceLauncher(LAUNCHER_PATH, 'replacement', { hooks: { afterClaim: () => r.put(LAUNCHER_PATH, 'newcomer') } }), (error) => {
    assert.equal(error.code, 'recovery')
    assert.equal(r.files.get(error.held)?.text, r.text)
    assert.equal(r.files.get(LAUNCHER_PATH)?.text, 'newcomer')
    return true
  })
})

test('the menu reports the retained launcher after a post-claim error', async () => {
  const r = rig()
  const requests = []
  r.faults((step, path) => {
    if (step === 'open' && path.endsWith('.held')) throw fail('EIO')
    if (step === 'link') throw fail('ENOTSUP')
  })
  const tool = r.createCommandLineTool({
    platform: 'darwin', home: FIXTURE_HOME, target: () => { throw fail('ENOENT') },
    showDialog: async (request) => { requests.push(request); return 1 },
  })
  const result = await tool.run()
  assert.equal(result.outcome, 'failed')
  assert.equal(r.files.get(result.held)?.text, r.text)
  assert.ok(requests.at(-1).detail.includes(result.held.replace(FIXTURE_HOME, '~')))
  assert.match(requests.at(-1).message, /could not be removed/)
})

for (const step of ['lstat', 'link', 'unlink']) {
  test(`recovery reports retained files when its ${step} fails`, () => {
    const r = rig()
    r.faults((at) => { if (at === step) throw fail('EIO') })
    assert.throws(() => r.removeLauncher({ home: FIXTURE_HOME, hooks: { afterClaim: () => { throw fail('EIO') } } }), (error) => {
      assert.equal(error.code, 'recovery')
      assert.equal(r.files.get(error.held)?.text, r.text)
      assert.equal(error.restored, step === 'unlink')
      if (error.restored) assert.equal(r.files.get(LAUNCHER_PATH)?.text, r.text)
      return true
    })
  })
}

test('a newcomer appearing during recovery survives when hard links are unavailable', () => {
  const r = rig()
  let newcomer
  r.faults((at, path) => {
    if (at === 'link') {
      r.put(path, 'newcomer')
      newcomer = r.files.get(path)
      throw fail('ENOTSUP')
    }
  })
  assert.throws(() => r.removeLauncher({ home: FIXTURE_HOME, hooks: { afterClaim: () => { throw fail('EIO') } } }), (error) => {
    assert.equal(r.files.get(LAUNCHER_PATH), newcomer)
    assert.equal(r.files.get(error.held)?.text, r.text)
    return error.code === 'recovery'
  })
})
