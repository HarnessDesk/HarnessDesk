import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
/** Release-only signature/probe inspection. Smoke uses only the unsigned layout check. */
const inspect = (bin, args) => {
  const result=spawnSync(bin,args,{encoding:'utf8',timeout:15000})
  if(result.status!==0) throw new Error(`iOS artifact inspection failed (${bin}).`)
  return bin==='codesign' ? `${result.stdout}${result.stderr}` : result.stdout
}
function helpersIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.name === 'hd-ios-control') return [path]
    return entry.isDirectory() ? helpersIn(path) : []
  })
}
/** A shared, unsigned layout check: no binary execution, signature or team inspection. */
export function verifyIosHelperUniqueness(app, { helpers = helpersIn } = {}) {
  const helper = join(app, 'Contents/Resources/native/ios/hd-ios-control')
  const copies = helpers(app)
  if (copies.length !== 1 || copies[0] !== helper) throw new Error('The packaged native resource must be the only hd-ios-control in the app bundle; extra helpers are forbidden.')
  return helper
}
export function verifyIosArtifact(app, arch, { run = inspect, helpers = helpersIn, log = console.log } = {}) {
  const helper = verifyIosHelperUniqueness(app, { helpers })
  const expected = arch === 'x64' ? 'x86_64' : arch
  if (!['arm64','x86_64'].includes(expected) || run('lipo',['-archs',helper]).trim() !== expected) throw new Error('The released iOS helper has the wrong architecture.')
  run('codesign',['--verify','--strict','--verbose=2',helper])
  const application = run('codesign',['--display','--verbose=4',app])
  const native = run('codesign',['--display','--verbose=4',helper])
  const team = text => text.match(/TeamIdentifier=([^\r\n]+)/)?.[1]
  if (!team(application) || team(application)==='not set' || team(application)!==team(native)) throw new Error('The released iOS helper must have the app signing identity.')
  if (!native.includes('(runtime)')) throw new Error('The released iOS helper must enable hardened runtime.')
  const developer = run('xcode-select', ['-p']).trim()
  if (!developer) throw new Error('The release verifier requires a selected Xcode developer directory.')
  // Match SimulatorBridge.m: dlopen tries each candidate until one loads.
  const frameworks = [
    ['CoreSimulator', [
      '/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator',
      join(developer, 'Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator'),
    ]],
    ['SimulatorKit', [
      join(developer, 'Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit'),
      join(dirname(developer), 'SharedFrameworks/SimulatorKit.framework/SimulatorKit'),
    ]],
  ].map(([name, candidates]) => {
    const archs = new Set()
    for (const candidate of candidates) {
      let slices
      try { slices = run('lipo', ['-archs', candidate]).trim().split(/\s+/) }
      catch { continue } // A missing/unreadable candidate cannot be loaded.
      for (const slice of slices) if (slice) archs.add(slice)
      if (slices.includes(expected) || (expected === 'arm64' && slices.includes('arm64e'))) break
    }
    return { name, archs: [...archs] }
  })
  const compatible = frameworks.every(({ archs }) => archs.includes(expected) || (expected === 'arm64' && archs.includes('arm64e')))
  if (!compatible) {
    const reason = `${expected} helper; ${frameworks.map(({ name, archs }) => `${name}: ${archs.join(' ') || 'missing'}`).join('; ')}`
    if (expected === 'arm64') throw new Error(`The installed Xcode frameworks cannot load the ${reason}.`)
    log(`Skipping iOS framework probe (${reason}): no compatible framework slice.`)
    return
  }
  const probe = JSON.parse(run(helper,['--probe']))
  if (probe.protocolVersion !== 1 || probe.frameworks !== 'available') throw new Error('The released iOS helper could not load the installed Xcode frameworks.')
}
