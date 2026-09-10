import { isAvatarId, type AvatarId } from './avatars'

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
 * "HarnessDesk" and the house mark — and a value equal to the default is
 * dropped on the way in, so "Reset" is offered exactly when there is
 * something to reset.
 */
export interface Profile {
  /** What you are called. Absent means the default. */
  readonly name?: string
  /** Which face. Absent means the house mark. */
  readonly avatar?: AvatarId
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
 * Counted in characters, not UTF-16 units, so an emoji is never cut in half.
 */
export const PROFILE_NAME_MAX = 40

const tidyName = (name: string): string =>
  Array.from(name.replace(/\s+/g, ' ').trim())
    .slice(0, PROFILE_NAME_MAX)
    .join('')
    .trim()

const clean = (name: string | null | undefined, avatar: unknown): Profile => {
  const tidy = typeof name === 'string' ? tidyName(name) : ''
  return {
    ...(tidy !== '' && tidy !== DEFAULT_PROFILE_NAME ? { name: tidy } : {}),
    ...(isAvatarId(avatar) ? { avatar } : {}),
  }
}

/**
 * The profile with `patch` applied. A field the patch does not mention is
 * kept; an empty name is the way back to the default, because clearing the
 * field is what a person does to mean it.
 */
export const applyProfile = (profile: Profile, patch: ProfilePatch): Profile =>
  clean(
    patch.name === undefined ? profile.name : patch.name,
    patch.avatar === undefined ? profile.avatar : patch.avatar,
  )

/**
 * A stored profile, read defensively. The preferences file is the user's: a
 * hand edit, an older build, or a face a later build no longer ships must not
 * take the seat down, so anything unreadable is simply the default.
 */
export const readProfile = (raw: unknown): Profile => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const record = raw as { readonly name?: unknown; readonly avatar?: unknown }
  return clean(typeof record.name === 'string' ? record.name : null, record.avatar)
}

/** What to call you on screen. */
export const profileName = (profile: Profile): string =>
  profile.name?.trim() || DEFAULT_PROFILE_NAME

/** Whether anything has been chosen — the question a "Reset" answers. */
export const isDefaultProfile = (profile: Profile): boolean =>
  profile.name === undefined && profile.avatar === undefined

export const sameProfile = (a: Profile, b: Profile): boolean =>
  a.name === b.name && a.avatar === b.avatar
