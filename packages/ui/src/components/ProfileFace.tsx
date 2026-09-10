import { avatarSrc, type AvatarId } from '../lib/avatars'
import { useSnapshot } from '../state/context'
import { HarnessMark } from './BrandIcons'
import styles from './ProfileFace.module.css'

/**
 * A face: the picture a person chose, or the house mark when they have not.
 *
 * One tile wherever a person is drawn — the seat, the top of its menu, the
 * top of the settings rail, the profile page and its picker — so the
 * footprint never changes when the face does. The tile is squared, the shape
 * the avatars were drawn for ("the app's avatars are squared tiles", their
 * README), and its corner grows with it, so the seat's 24px and the profile
 * page's 56px read as one object at two sizes rather than two objects.
 *
 * Without a `size` it fills the box it is put in and takes that box's corner:
 * a room's message rows already draw a tile for every sender, and a person's
 * face belongs in the same tile as the agents' marks beside it.
 *
 * The default is not an avatar and is not drawn as one. It is the product's
 * own glyph on `currentColor`, which is why it follows the theme — and why
 * the whale sticker drawn in black, which cannot, is not on offer.
 */
export const Face = ({
  avatar,
  size,
  className,
}: {
  readonly avatar: AvatarId | null | undefined
  /** The tile's edge in px; absent, the tile fills its box. */
  readonly size?: number
  readonly className?: string
}) => {
  const src = avatar ? avatarSrc(avatar) : null
  return (
    <span
      className={className ? `${styles.face} ${className}` : styles.face}
      {...(size === undefined
        ? { 'data-fill': '' }
        : { 'data-size': size > 48 ? 'l' : size > 32 ? 'm' : 's', style: { width: size, height: size } })}
      aria-hidden="true"
    >
      {src ? (
        <img className={styles.picture} src={src} alt="" draggable={false} />
      ) : (
        // 0.44 is the ratio the seat always drew at: an 11px mark in its
        // 24px disc, 13px in the menu's 30px one. A filling tile sizes the
        // mark in its stylesheet, by the same ratio.
        <HarnessMark size={size === undefined ? 16 : Math.round(size * 0.44)} />
      )}
    </span>
  )
}

/** Your own face, as the profile has it. */
export const ProfileFace = ({ size, className }: { readonly size?: number; readonly className?: string }) => {
  const { profile } = useSnapshot()
  return <Face avatar={profile.avatar} size={size} className={className} />
}
