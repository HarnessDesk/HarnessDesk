import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforePack as prepareLead, LEAD_NODE_DIR } from './fetch-lead-node.mjs'
import { LEAD_NODE } from '../electron/lead-runtime.mjs'
import { buildIosControl } from '../../../script/build-ios-control.mjs'
/** Both nested executables must exist before electron-builder copies and signs resources. */
export const beforePack = async (context) => {
  const arch = { 1: 'x64', 3: 'arm64' }[context.arch]
  if (context.electronPlatformName !== 'darwin' || !arch) throw new Error('Native iOS packaging requires a supported macOS architecture.')
  await buildIosControl({ arch, required: true })
  // Offline verification runs must never cause the existing Lead fetch hook to download a binary.
  if (process.env['HARNESSDESK_NO_DOWNLOADS'] === '1') {
    const folder=join(LEAD_NODE_DIR,arch), stamp=join(folder,'.verified')
    if (!existsSync(join(folder,'bin/node')) || !existsSync(stamp) || readFileSync(stamp,'utf8') !== `${LEAD_NODE.version} ${LEAD_NODE.sha256[arch]}\n`) throw new Error('Offline packaging requires the already verified Lead runtime cache; downloads are disabled.')
  }
  await prepareLead(context)
}
