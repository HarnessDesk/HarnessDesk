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
const FIXTURE_HOME = '/home/user'
const LAUNCHER_PATH = `${FIXTURE_HOME}/.local/bin/harnessdesk`
const fail = (code) => Object.assign(new Error(`injected ${code}`), { code })

const rig = () => {
  const files = new Map()
  const descriptors = new Map()
  let next = 1
  let fault = () => {}
  const put = (path, text, kind = 'file') => files.set(path, {
    text, kind, ino: BigInt(next++), dev: 1n, mode: 0o100755n,
    birthtimeNs: BigInt(next), ctimeNs: BigInt(next),
  })
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
    renameSync(from, to) {
      fault('rename', to)
      const file = get(from)
      if (file.ctimeNs > 0n) file.ctimeNs += 1n
      files.set(to, file)
      files.delete(from)
    },
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
  runInNewContext(`${source}\nglobalThis.api = { removeLauncher, replaceLauncher, installLauncher, createCommandLineTool, launcherText };`, sandbox)
  const api = sandbox.api
  const text = api.launcherText({ runtime: '/Applications/HarnessDesk.app/runtime', entry: '/Applications/HarnessDesk.app/bin.js' })
  put(LAUNCHER_PATH, text)
  return { ...api, files, put, text, faults: (fn) => { fault = fn } }
}

for (const action of ['remove', 'replace', 'install']) {
  for (const difference of ['text with equal size and timestamps', 'mode', 'birthtimeNs', 'ctimeNs']) {
    test(`${action} preserves a swapped launcher with a reused inode and different ${difference}`, () => {
      const r = rig()
      let swapped
      const hooks = { afterCheck: () => {
        const old = r.files.get(LAUNCHER_PATH)
        // Give the new file exactly the same device and inode, independently
        // of whether the real filesystem happens to reuse one on this run.
        r.put(LAUNCHER_PATH, old.text)
        swapped = Object.assign(r.files.get(LAUNCHER_PATH), old)
        if (difference.startsWith('text')) swapped.text = old.text.replace('/runtime', '/changed')
        else swapped[difference] += 1n
      } }
      assert.throws(() => action === 'remove'
        ? r.removeLauncher({ home: FIXTURE_HOME, hooks })
        : action === 'replace'
          ? r.replaceLauncher(LAUNCHER_PATH, 'replacement', { hooks })
          : r.installLauncher({ home: FIXTURE_HOME, target: { runtime: '/new/runtime', entry: '/new/bin.js' }, loginPath: null, hooks }),
      (error) => error.code === 'changed' && error.restored === true && !error.held)
      assert.equal(r.files.get(LAUNCHER_PATH), swapped, 'the swapped file is restored, not overwritten or deleted')
      assert.equal(r.files.size, 1, 'no prepared or held file remains')
    })
  }
}

test('a reused inode swapped during the claim is checked against the held text', () => {
  const r = rig()
  let swapped
  r.faults((step, path) => {
    if (step !== 'rename' || !path.endsWith('.held')) return
    const old = r.files.get(LAUNCHER_PATH)
    r.put(LAUNCHER_PATH, old.text)
    swapped = Object.assign(r.files.get(LAUNCHER_PATH), old, { text: old.text.replace('/runtime', '/changed') })
  })
  assert.throws(() => r.removeLauncher({ home: FIXTURE_HOME }), { code: 'changed' })
  assert.equal(r.files.get(LAUNCHER_PATH), swapped)
})

for (const timestamp of [0n, undefined]) {
  test(`identical text and stat facts with ${timestamp === 0n ? 'zero' : 'unavailable'} timestamps can be replaced and removed`, () => {
    const r = rig()
    const original = r.files.get(LAUNCHER_PATH)
    original.birthtimeNs = timestamp
    original.ctimeNs = timestamp
    const hooks = { afterCheck: () => {
      const old = r.files.get(LAUNCHER_PATH)
      r.put(LAUNCHER_PATH, old.text)
      Object.assign(r.files.get(LAUNCHER_PATH), old)
    } }
    r.replaceLauncher(LAUNCHER_PATH, r.text, { hooks })
    assert.equal(r.files.get(LAUNCHER_PATH).text, r.text)
    assert.equal(r.removeLauncher({ home: FIXTURE_HOME, hooks }).status, 'removed')
    assert.equal(r.files.size, 0)
  })
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

for (const reason of ['recovery', 'changed']) {
  test(`a first install reports ${reason} details when a concurrent install becomes a replacement`, async () => {
    const r = rig()
    const requests = []
    const app = { runtime: '/Applications/HarnessDesk.app/runtime', entry: '/Applications/HarnessDesk.app/bin.js' }
    const older = r.launcherText({ ...app, runtime: '/Applications/Older/HarnessDesk.app/runtime' })
    r.files.delete(LAUNCHER_PATH)
    r.put(app.runtime, '')
    r.put(app.entry, '')
    r.faults((step, path) => {
      if (reason === 'recovery' && step === 'open' && path.endsWith('.held')) throw fail('EIO')
      if (reason === 'changed' && step === 'rename' && path.endsWith('.held')) r.put(LAUNCHER_PATH, 'another command')
      if (step === 'link') throw fail('ENOTSUP')
    })
    const tool = r.createCommandLineTool({
      platform: 'darwin', home: FIXTURE_HOME, target: () => app,
      loginPath: async () => { r.put(LAUNCHER_PATH, older); return `${FIXTURE_HOME}/.local/bin` },
      showDialog: async (request) => { requests.push(request); return 0 },
    })
    const result = await tool.run()
    assert.equal(result.path, LAUNCHER_PATH)
    assert.equal(result.outcome, reason === 'recovery' ? 'failed' : 'changed')
    if (reason === 'recovery') assert.equal(result.restored, false)
    assert.equal(r.files.get(result.held)?.text, reason === 'recovery' ? older : 'another command')
    assert.equal(r.files.has(LAUNCHER_PATH), false)
    assert.equal(requests.length, 1)
    assert.ok(requests[0].detail.includes(result.held.replace(FIXTURE_HOME, '~')))
    assert.match(requests[0].message, reason === 'recovery' ? /could not be installed/ : /was not installed/)
  })
}

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
