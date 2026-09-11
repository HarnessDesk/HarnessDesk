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
 * "HarnessDesk" and the house mark — and a name equal to the default is
 * dropped on the way in, so "Reset" is offered exactly when there is
 * something to reset.
 *
 * What a later build stores, this one keeps: every field it does not know,
 * and whatever `avatar` holds. The profile is written whole (`setProfile`), so
 * a read that dropped them — a face added after this build, a picture of your
 * own, a field an account brings — would lose them for good on the next edit
 * of the name, and a profile synced between copies of different ages would
 * lose them on a loop. So the read keeps them, the write puts them back, and
 * only drawing falls back: `Face` draws the house mark for a face this build
 * does not ship. The one field the read does not carry is a `name` that is not
 * a string — the name stays a string, and an account is expected to supply a
 * string there too.
 */
export interface Profile {
  /** What you are called. Absent means the default. */
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
 * one, and none is cut in half — here, and by the field that types it.
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

const clean = (later: Readonly<Record<string, unknown>> | undefined, name: unknown, avatar: unknown): Profile => {
  const tidy = typeof name === 'string' ? tidyName(name) : ''
  return {
    ...(tidy !== '' && tidy !== DEFAULT_PROFILE_NAME ? { name: tidy } : {}),
    ...(avatar !== undefined && avatar !== null && avatar !== '' ? { avatar } : {}),
    ...(later && Object.keys(later).length > 0 ? { later } : {}),
  }
}

/**
 * The profile with `patch` applied. A field the patch does not mention is
 * kept — including any this build does not know; an empty name is the way
 * back to the default, because clearing the field is what a person does to
 * mean it.
 */
export const applyProfile = (profile: Profile, patch: ProfilePatch): Profile =>
  clean(
    profile.later,
    patch.name === undefined ? profile.name : patch.name,
    patch.avatar === undefined ? profile.avatar : patch.avatar,
  )

/**
 * A stored profile, read defensively and forward. The preferences file is the
 * user's: a hand edit this build cannot read must not take the seat down, so
 * an unreadable name is simply the default — and what a later build stored is
 * kept, so the next whole write carries it back.
 */
export const readProfile = (raw: unknown): Profile => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const record = raw as Readonly<Record<string, unknown>>
  const later = Object.fromEntries(Object.entries(record).filter(([field]) => field !== 'name' && field !== 'avatar'))
  return clean(later, record['name'], record['avatar'])
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
