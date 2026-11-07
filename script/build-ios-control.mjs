import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, copyFileSync, chmodSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const execute = promisify(execFile)
export async function buildIosControl({ platform = process.platform, arch = process.arch, required = false, run = execute, exists = existsSync, remove = (path) => rmSync(path, { force: true }) } = {}) {
  if (platform !== 'darwin') return
  if (!['arm64', 'x64'].includes(arch)) throw Error('Unsupported iOS helper architecture.')
  const nativeArch = arch === 'x64' ? 'x86_64' : arch
  const source = resolve(root, 'packages/cordis-host/native/ios-control')
  const output = resolve(root, `packages/cordis-host/dist/native/darwin-${arch}/hd-ios-control`)
  try {
    await run('xcrun', ['--find', 'simctl'])
    await run('swift', ['build', '--package-path', source, '-c', 'release', '--arch', nativeArch], { timeout: 120000 })
    const { stdout } = await run('swift', ['build', '--package-path', source, '-c', 'release', '--arch', nativeArch, '--show-bin-path'])
    const binary = resolve(stdout.trim(), 'hd-ios-control')
    if (!exists(binary)) throw Error('Native compiler did not produce helper output.')
    const geometry = await run('lipo', ['-archs', binary])
    if (geometry.stdout.trim() !== nativeArch) throw Error('Native helper has the wrong architecture.')
    mkdirSync(dirname(output), { recursive: true })
    copyFileSync(binary, output)
    chmodSync(output, 0o755)
    return output
  } catch (error) {
    remove(output)
    if (required) throw error
    console.error('iOS input helper unavailable; select a full Xcode to build it.')
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const at = process.argv.indexOf('--arch')
  await buildIosControl({ arch: at < 0 ? process.arch : process.argv[at + 1], required: process.argv.includes('--required') })
}
