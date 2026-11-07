import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
/** Release-only inspection of an already signed/notarized app. Never signs or notarizes. */
const inspect = (bin, args) => {
  const result=spawnSync(bin,args,{encoding:'utf8',timeout:15000})
  if(result.status!==0) throw new Error(`iOS artifact inspection failed (${bin}).`)
  return bin==='codesign' ? `${result.stdout}${result.stderr}` : result.stdout
}
export function verifyIosArtifact(app, arch, { run = inspect } = {}) {
  const helper = join(app, 'Contents/Resources/native/ios/hd-ios-control')
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
