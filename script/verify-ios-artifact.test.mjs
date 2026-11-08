import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyIosArtifact } from './verify-ios-artifact.mjs'

const app = '/synthetic/HarnessDesk.app'
const helper = `${app}/Contents/Resources/native/ios/hd-ios-control`
const developer = '/synthetic/Xcode.app/Contents/Developer'
const core = '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator'
const kit = `${developer}/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit`
const signed = 'TeamIdentifier=DEMO123\nflags=0x10000(runtime)\n'
function fixture({ arch = 'arm64', frameworks = 'arm64e', broken, paths } = {}) {
  const calls = [], messages = []
  return { calls, messages, options: {
    helpers: () => broken === 'duplicate' ? [helper, `${app}/Contents/extra/hd-ios-control`] : [helper],
    log: message => messages.push(message),
    run: (bin, args) => {
      calls.push([bin, ...args])
      if (bin === 'xcode-select') return `${developer}\n`
      if (bin === 'lipo') {
        if (args.at(-1) === helper) return broken === 'arch' ? 'wrong' : arch
        const slices = paths ? paths[args.at(-1)] : frameworks
        if (!slices) throw Error('framework missing')
        return slices
      }
      if (bin === 'codesign') {
        if (args.includes('--verify') && broken === 'signature') throw Error('invalid signature')
        return broken === 'team' && args.at(-1) === helper ? signed.replace('DEMO123', 'OTHER')
          : broken === 'runtime' ? signed.replace('(runtime)', '') : signed
      }
      assert.equal(bin, helper)
      if (broken === 'probe') throw Error('framework load failed')
      return JSON.stringify({ protocolVersion: 1, frameworks: 'available' })
    },
  } }
}
const probes = calls => calls.filter(call => call[0] === helper && call[1] === '--probe')

test('artifact verifier rejects architecture, signature and framework-load failures', () => {
  for (const broken of ['arch', 'signature', 'team', 'runtime', 'probe', 'duplicate']) {
    assert.throws(() => verifyIosArtifact(app, 'arm64', fixture({ broken }).options))
  }
})

test('x64 skips only the probe for arm64e-only frameworks and explains the slices', () => {
  const { options, calls, messages } = fixture({ arch: 'x86_64', broken: 'probe' })
  verifyIosArtifact(app, 'x64', options)
  assert.equal(probes(calls).length, 0)
  assert.ok(calls.some(call => call[0] === 'lipo' && call.at(-1) === helper))
  assert.ok(calls.some(call => call[0] === 'codesign' && call.includes('--verify') && call.includes('--strict')))
  for (const target of [app, helper]) assert.ok(calls.some(call => call[0] === 'codesign' && call.includes('--display') && call.at(-1) === target))
  assert.equal(messages.length, 1)
  assert.match(messages[0], /skip.*x86_64.*CoreSimulator.*arm64e.*SimulatorKit.*arm64e/i)
  for (const broken of ['arch', 'signature', 'team', 'runtime', 'duplicate']) {
    assert.throws(() => verifyIosArtifact(app, 'x64', fixture({ arch: 'x86_64', broken }).options), undefined, broken)
  }
})

for (const [arch, frameworks] of [['x64', 'x86_64'], ['arm64', 'arm64e'], ['arm64', 'arm64']]) {
  test(`${arch} executes the signed helper probe with ${frameworks} frameworks`, () => {
    const { options, calls, messages } = fixture({ arch: arch === 'x64' ? 'x86_64' : arch, frameworks })
    verifyIosArtifact(app, arch, options)
    assert.equal(probes(calls).length, 1)
    assert.deepEqual(messages, [])
    assert.throws(() => verifyIosArtifact(app, arch, fixture({ arch: arch === 'x64' ? 'x86_64' : arch, frameworks, broken: 'probe' }).options), /framework load failed/)
  })
}

for (const frameworks of [null, 'x86_64']) {
  test(`arm64 refuses ${frameworks ?? 'missing'} frameworks rather than skipping`, () => {
    const { options, calls, messages } = fixture({ frameworks })
    assert.throws(() => verifyIosArtifact(app, 'arm64', options), /arm64.*CoreSimulator.*SimulatorKit/)
    assert.equal(probes(calls).length, 0)
    assert.deepEqual(messages, [])
  })
}

test('framework discovery follows both bridge fallback paths and accepts a later compatible slice', () => {
  const { options, calls } = fixture({ paths: {
    [core]: 'x86_64',
    [`${developer}/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator`]: 'arm64e',
    [`/synthetic/Xcode.app/Contents/SharedFrameworks/SimulatorKit.framework/SimulatorKit`]: 'arm64e',
  } })
  verifyIosArtifact(app, 'arm64', options)
  assert.ok(calls.some(call => call[0] === 'xcode-select' && call[1] === '-p'))
  assert.ok(calls.some(call => call[0] === 'lipo' && call.at(-1) === kit))
  assert.equal(probes(calls).length, 1)
})

test('arm64 requires a compatible slice in each framework', () => {
  for (const paths of [{ [core]: 'arm64e' }, { [kit]: 'arm64e' }]) {
    assert.throws(() => verifyIosArtifact(app, 'arm64', fixture({ paths }).options), /arm64.*CoreSimulator.*SimulatorKit/)
  }
})
