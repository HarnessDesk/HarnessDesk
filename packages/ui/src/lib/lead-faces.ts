import type { LeadName } from '@harnessdesk/protocol'

/** How the Lead looks right now; one face per presence, never animated. */
export type LeadMood = 'neutral' | 'working' | 'done' | 'alert' | 'sleeping'

/**
 * The Lead's faces, as the bundler hands them out.
 *
 * Two folders: 48px holds only the neutral face, because below 28px an
 * expression does not read and the presence word says it instead; 112px holds
 * every mood for the status popover and the picker cards, at 2x of their 52px.
 */
const SMALL = import.meta.glob<string>('../../../../assets/lead/48/*.png', { eager: true, query: '?url', import: 'default' })
const LARGE = import.meta.glob<string>('../../../../assets/lead/112/*.png', { eager: true, query: '?url', import: 'default' })

export const leadFaceSrc = (name: LeadName, mood: LeadMood, large: boolean): string | null =>
  large ? LARGE[`../../../../assets/lead/112/${name}-${mood}.png`] ?? null : SMALL[`../../../../assets/lead/48/${name}-neutral.png`] ?? null
