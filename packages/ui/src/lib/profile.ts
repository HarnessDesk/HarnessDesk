import type { AvatarId } from './avatars'

/**
 * Who you are on this desk: a name and a face.
 *
 * Nothing else, because nothing else is shown. The seat at the bottom of the
 * sidebar, the top of its menu, the top of the settings rail and your own
 * messages in a room all draw you, and all of them draw these two things.
 *
 * There is no HarnessDesk account yet, so the profile is a preference kept on
 * this Mac the way the theme is. When there is one, the account supplies the
 * same two fields and this becomes what a signed-out desk shows. That is why
 * every surface reads it through `profileName` and `ProfileFace` rather than
 * off the field: the answer changes in one place, and the sidebar, the menu,
 * the rail and the rooms follow it together. An agent's account is a
 * different thing entirely — a pen, not a person — and keeps its own name
 * and ring (`lib/accounts.ts`).
 *
 * Only what differs from the default is stored. `{}` is the default desk —
 * "HarnessDesk" and the house mark — and a name typed equal to the default,
 * or typed empty, is dropped on the way in, so "Reset" is offered exactly
 * when there is something to reset.
 *
 * What a later build stores, this one keeps: every field it does not know,
 * whatever `avatar` holds, and the name exactly as it was written. The profile
 * is written whole (`setProfile`), so a read that dropped any of them — a face
 * added after this build, a picture of your own, a field an account brings —
 * or held the name to this build's rules — a longer cap, its own spacing —
 * would lose them for good on the next write of anything, and a profile
 * synced between copies of different ages would lose them on a loop. So the
 * read keeps them, the write puts them back, and only two things fall back:
 * drawing, where `Face` draws the house mark for a face this build does not
 * ship, and an edit made here, which `applyProfile` holds to this build's
 * rules — the name it is given is tidied, never the one it keeps. What the read
 * does not carry is a name that says nothing — blank, every build's spelling
 * of the default — and a `name` that is not a string: the name stays a
 * string, and an account is expected to supply a string there too.
 */
export interface Profile {
  /** What you are called, as stored: tidied when typed here, as written when not. Absent means the default. */
  readonly name?: string
  /**
   * Which face, as stored: one of the ids this build ships, or whatever a
   * later build wrote there — kept, and drawn as the house mark. Absent is the
   * house mark.
   */
  readonly avatar?: unknown
  /**
   * Every other field the stored profile had — a later build's — kept as it
   * was and written back beside the two this build knows (`storedProfile`). In
   * a bag of its own rather than under an index signature, so the interface
   * stays closed: a misspelled read of `name` or `avatar` fails to compile,
   * where it would otherwise draw the default forever.
   */
  readonly later?: Readonly<Record<string, unknown>>
}

/** A change to the profile. `null` puts that field back to its default. */
export interface ProfilePatch {
  readonly name?: string | null
  readonly avatar?: AvatarId | null
}

/** The name nobody chose: the product's own, until you give it yours. */
export const DEFAULT_PROFILE_NAME = 'HarnessDesk'

/**
 * Long enough for a full name, short enough that the seat's row cuts it with
 * an ellipsis rather than the name crowding out the agent badge beside it.
 * Counted in characters as a person sees them — a flag or a family emoji is
 * one, and none is cut in half — here, and by the field that types it. It
 * holds what is typed here: a name a later build let run longer is kept as it
 * is until it is edited.
 */
export const PROFILE_NAME_MAX = 40

const graphemes =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/**
 * A string as the characters a person sees: grapheme clusters, so 🇺🇸 is one
 * and not two. Code points where `Intl.Segmenter` is missing.
 */
export const characters = (text: string): string[] =>
  graphemes ? Array.from(graphemes.segment(text), (part) => part.segment) : Array.from(text)

const tidyName = (name: string): string =>
  characters(name.replace(/\s+/g, ' ').trim())
    .slice(0, PROFILE_NAME_MAX)
    .join('')
    .trim()

/**
 * A name as typed here, as this build keeps it: tidied, and nothing at all
 * when that leaves it empty or the default.
 */
const typedName = (name: string | null): string | undefined => {
  const tidy = name === null ? '' : tidyName(name)
  return tidy === '' || tidy === DEFAULT_PROFILE_NAME ? undefined : tidy
}

const settle = (
  later: Readonly<Record<string, unknown>> | undefined,
  name: string | undefined,
  avatar: unknown,
): Profile => ({
  ...(name !== undefined ? { name } : {}),
  ...(avatar !== undefined && avatar !== null && avatar !== '' ? { avatar } : {}),
  ...(later && Object.keys(later).length > 0 ? { later } : {}),
})

/**
 * The profile with `patch` applied. A field the patch does not mention is
 * kept exactly — including any this build does not know, and a name no edit
 * here has touched; the name a patch brings is tidied. An empty name is the
 * way back to the default, because clearing the field is what a person does
 * to mean it.
 */
export const applyProfile = (profile: Profile, patch: ProfilePatch): Profile =>
  settle(
    profile.later,
    patch.name === undefined ? profile.name : typedName(patch.name),
    patch.avatar === undefined ? profile.avatar : patch.avatar,
  )

/**
 * A stored profile, read defensively and forward. The preferences file is the
 * user's: a hand edit this build cannot read must not take the seat down, so
 * an unreadable name is simply the default — and what a later build stored is
 * kept as it was, the name untidied, so the next whole write carries it back.
 */
export const readProfile = (raw: unknown): Profile => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const record = raw as Readonly<Record<string, unknown>>
  const later = Object.fromEntries(Object.entries(record).filter(([field]) => field !== 'name' && field !== 'avatar'))
  const name = record['name']
  return settle(later, typeof name === 'string' && name.trim() !== '' ? name : undefined, record['avatar'])
}

/**
 * The profile as the preferences file holds it: what a later build stored,
 * back at the top level beside the two fields this build knows — the shape
 * `readProfile` reads, so a profile passes through this build unchanged.
 */
export const storedProfile = (profile: Profile): Readonly<Record<string, unknown>> => ({
  ...profile.later,
  ...(profile.name !== undefined ? { name: profile.name } : {}),
  ...(profile.avatar !== undefined ? { avatar: profile.avatar } : {}),
})

/** What to call you on screen. */
export const profileName = (profile: Profile): string =>
  profile.name?.trim() || DEFAULT_PROFILE_NAME

/** Whether anything has been chosen — the question a "Reset" answers. */
export const isDefaultProfile = (profile: Profile): boolean =>
  profile.name === undefined && profile.avatar === undefined

/** Whether two profiles would store the same thing — the store's gate on writing at all. */
export const sameProfile = (a: Profile, b: Profile): boolean =>
  a.name === b.name && a.avatar === b.avatar && a.later === b.later
