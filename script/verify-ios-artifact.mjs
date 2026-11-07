import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
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
export function verifyIosArtifact(app, arch, { run = inspect, helpers = helpersIn } = {}) {
  const helper = verifyIosHelperUniqueness(app, { helpers })
  const expected = arch === 'x64' ? 'x86_64' : arch
  if (!['arm64','x86_64'].includes(expected) || run('lipo',['-archs',helper]).trim() !== expected) throw new Error('The released iOS helper has the wrong architecture.')
  run('codesign',['--verify','--strict','--verbose=2',helper])
  const application = run('codesign',['--display','--verbose=4',app])
  const native = run('codesign',['--display','--verbose=4',helper])
  const team = text => text.match(/TeamIdentifier=([^\r\n]+)/)?.[1]
  if (!team(application) || team(application)==='not set' || team(application)!==team(native)) throw new Error('The released iOS helper must have the app signing identity.')
  if (!native.includes('(runtime)')) throw new Error('The released iOS helper must enable hardened runtime.')
  const probe = JSON.parse(run(helper,['--probe']))
  if (probe.protocolVersion !== 1 || probe.frameworks !== 'available') throw new Error('The released iOS helper could not load the installed Xcode frameworks.')
}
