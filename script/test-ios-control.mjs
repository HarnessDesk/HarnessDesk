import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export function testIosControl({ platform = process.platform, run = spawnSync, log = console.log } = {}) {
  if (platform !== 'darwin') { log('Skipping Swift simulator tests: macOS with Xcode 27 is required.'); return }
  const version = run('xcodebuild', ['-version'], { encoding: 'utf8', timeout: 15000 })
  const major = Number(version.stdout?.match(/^Xcode (\d+)/m)?.[1] ?? 0)
  if (version.status !== 0 || major < 27) { log('Skipping Swift simulator tests: select Xcode 27 or newer.'); return }
  const result = run('swift', ['test', '--package-path', 'packages/cordis-host/native/ios-control'], { encoding: 'utf8', timeout: 180000 })
  if (result.stdout) log(result.stdout)
  if (result.stderr) log(result.stderr)
  if (result.status !== 0) throw new Error('Swift simulator tests failed.')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) testIosControl()
