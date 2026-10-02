import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { FlowBase, FlowBasePin } from '@harnessdesk/protocol'

import { HARDENED_GIT_CONFIG } from './git-hardening.js'

const exec = promisify(execFile)

/** Fetch once into this run's retained ref: no checkout, index, FETCH_HEAD or tracking ref is changed. */
export const fetchFlowBase = async (root: string, base: FlowBase, run: string): Promise<FlowBasePin> => {
  const git = async (...args: string[]): Promise<string> =>
    (await exec('git', ['-C', root, ...HARDENED_GIT_CONFIG, ...args], { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim()
  const ref = `refs/harnessdesk/flow-base/${run}`
  try {
    // A name only: a flow cannot supply a URL, path, option or remote helper.
    if (!(await git('remote')).split('\n').includes(base.remote)) throw new Error('The configured remote does not exist.')
    await git('check-ref-format', ref)
    const from = base.branch === undefined ? 'HEAD' : `refs/heads/${base.branch}`
    if (base.branch !== undefined) await git('check-ref-format', from)
    await git('fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap=', '--', base.remote, `+${from}:${ref}`)
    const at = await git('rev-parse', '--verify', `${ref}^{commit}`)
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(at)) throw new Error('The fetched base is not a complete commit id.')
    // Keeping the ref keeps the commit reachable even if the remote moves and a later round opens after gc.
    return { ...base, at }
  } catch {
    // Git's stderr may contain credential-bearing URLs; name only the requested remote and branch here.
    throw new Error(`The Flow base could not be fetched from remote "${base.remote}" (${base.branch ?? 'default branch'}). Check the remote and branch, then start again. No work was started.`)
  }
}
