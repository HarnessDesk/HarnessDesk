import type { FlowEvidenceGuard, FlowPolicy, FlowPreview } from '@harnessdesk/protocol'

/**
 * Flows, in words.
 *
 * A dry run reads a compiled policy and a set of would-be seats; this turns
 * both into the sentences a person reads before pressing Start, so the
 * catalogue row, the dry run and Update's diff cannot say the guard three
 * different ways. Pure: no store, no React.
 */

/** One evidence guard, as a requirement a person reads before a round opens. */
export const evidenceGuardWords = (guard: FlowEvidenceGuard): string => {
  if ('check' in guard) return `A passing “${guard.check}” check at the selected revision`
  if ('ci' in guard) return 'CI green at the selected revision'
  if ('review' in guard) return `A recorded review of “${guard.review}” at the selected revision`
  if ('pr' in guard) return guard.pr === 'open' ? 'The pull request open' : 'The pull request merged'
  return 'A committed change in the step’s checkout'
}

/** Every guard a rule names, joined the way a sentence lists requirements. */
export const evidenceGuardsWords = (guards: readonly FlowEvidenceGuard[]): string =>
  guards.map(evidenceGuardWords).join(', and ')

/** Board-only or open messaging, said the way the dry run discloses it — never a policy word. */
export const messagingWords = (messaging: FlowPreview['messaging']): string =>
  messaging === 'members' ? 'Members may message each other' : 'Board-only: members do not message each other'

/**
 * The role a flow's `layout` designates for `/race`'s two-seat substitution,
 * or null when the file carries no such marker.
 *
 * Designation is ordinary UI metadata preserved in `layout`, never a second
 * execution type the engine reads — a customized comparison file that drops
 * or renames this still runs exactly as it is written, and simply stops
 * offering itself to `/race`.
 */
export const raceRoleId = (flow: FlowPolicy): string | null => {
  const layout = flow.layout
  if (!layout || typeof layout !== 'object') return null
  const race = (layout as { readonly race?: unknown }).race
  return typeof race === 'string' && race.trim() ? race.trim() : null
}

/** The compact `runtime=model/effort` grammar a flow file's `seats:` list is written in. */
export const seatSpecOf = (seat: { readonly runtime: string; readonly model?: string | null; readonly effort?: string | null; readonly thinking?: boolean }): string =>
  `${seat.runtime}${seat.model ? `=${seat.model}` : ''}${seat.effort ? `/${seat.effort}` : ''}${seat.thinking ? '+' : ''}`

const yamlString = (text: string): string => JSON.stringify(text)

/**
 * Rewrites one designated Agent role's `uses:`/`seats:` lines in a flow's raw
 * source, in place — the "same validated serializer" idiom a role's own
 * seats are already written in, applied by text surgery rather than a second
 * YAML writer: the file keeps every byte outside that one role's block, and
 * `previewFlow` is what actually validates the result before anyone starts
 * it.
 *
 * Returns null when the role cannot be found as a block of its own — a
 * customized file that moved or flattened it — so the caller can refuse
 * rather than silently edit nothing.
 */
export const substituteAgentRole = (
  source: string,
  roleId: string,
  agentId: string,
  seats: readonly { readonly runtime: string; readonly model?: string | null; readonly effort?: string | null; readonly thinking?: boolean }[],
): string | null => {
  const lines = source.split('\n')
  const escaped = roleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const roleAt = lines.findIndex((line) => new RegExp(`^(\\s*)${escaped}:\\s*$`).test(line))
  if (roleAt === -1) return null
  const roleIndent = lines[roleAt]!.match(/^(\s*)/)![1]!.length
  let blockEnd = lines.length
  for (let i = roleAt + 1; i < lines.length; i++) {
    const indent = lines[i]!.match(/^(\s*)\S/)?.[1]?.length
    if (indent !== undefined && indent <= roleIndent) {
      blockEnd = i
      break
    }
  }
  // Every line of this one role's block, with its pre-existing `seats:`/
  // `count:` dropped: the substituted seats list is always the whole answer
  // to "how many, and which", so nothing is left that could disagree with it.
  const block = lines.slice(roleAt, blockEnd).filter((line) => !/^\s*(seats|count):/.test(line))
  const usesAt = block.findIndex((line) => /^\s*uses:/.test(line))
  if (usesAt === -1) return null
  const usesIndent = block[usesAt]!.match(/^(\s*)/)![1]!
  const seatsLine = `${usesIndent}seats: [${seats.map((seat) => yamlString(seatSpecOf(seat))).join(', ')}]`
  const nextBlock = [...block]
  nextBlock[usesAt] = `${usesIndent}uses: [${yamlString(agentId)}]`
  nextBlock.splice(usesAt + 1, 0, seatsLine)
  return [...lines.slice(0, roleAt), ...nextBlock, ...lines.slice(blockEnd)].join('\n')
}
