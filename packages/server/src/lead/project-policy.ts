import { compareLeadPolicyAuthority } from '@harnessdesk/lead'
import { parseLeadPermissionPolicy, type LeadPermissionPolicy } from '@harnessdesk/protocol'
import { ConfinedTree } from '../confined-tree.js'

/** Host-side only. Repository bytes are untrusted and never sent to the child.
 * ConfinedTree refuses links and bounds both the stat and descriptor read. */
export const loadLeadProjectPolicy = async (root: string, desk: LeadPermissionPolicy): Promise<LeadPermissionPolicy | null> => {
  const text = await (await ConfinedTree.open(root)).read('.harnessdesk/lead.json', 64 * 1024)
  if (text === null) return null
  let policy: LeadPermissionPolicy
  try { policy = parseLeadPermissionPolicy(JSON.parse(text) as unknown) }
  catch { throw new Error('Malformed Lead project policy blocks management.') }
  const change = compareLeadPolicyAuthority(desk, policy)
  if (change === 'widening' || change === 'mixed') throw new Error('A widening Lead project policy blocks management.')
  return policy
}
