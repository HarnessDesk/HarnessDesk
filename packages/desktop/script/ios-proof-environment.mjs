export function proofEnvironment(devices, runtimes, udid, xcode, arch) {
  if (!['arm64','x64'].includes(arch)) throw Error('The proof requires a built helper for this architecture.')
  const entry = Object.entries(devices.devices).find(([,list])=>list.some(d=>d.udid===udid))
  const runtime = runtimes.runtimes.find(r=>r.identifier===entry?.[0])
  if (!runtime || !/^Xcode \d+/m.test(xcode)) throw Error('The measured Xcode or simulator runtime could not be identified.')
  return {runtime:runtime.name,runtimeIdentifier:runtime.identifier,xcode:xcode.trim(),helper:`packages/cordis-host/dist/native/darwin-${arch}/hd-ios-control`}
}
export async function measureProofEnvironment({ run, devices, udid, arch }) {
  const [xcode, runtimes] = await Promise.all([run('xcodebuild', ['-version']), run('xcrun', ['simctl', 'list', 'runtimes', '-j'])])
  return proofEnvironment(devices, JSON.parse(runtimes.stdout), udid, xcode.stdout, arch)
}
