import { Face } from '../design/primitives/Kit'
import { useSnapshot } from '../state/context'

/**
 * Your own face, as the profile has it: the design system's `Face`, reading
 * the store. It is how a surface that draws you once asks for you — the seat,
 * its menu, the settings rail — where one more subscription costs nothing,
 * since each of them re-renders with the snapshot anyway. A room's stream
 * draws you on every row you wrote, so it passes `profile.avatar` from the
 * snapshot it already holds to `Face` instead.
 */
export const ProfileFace = ({ size, className }: { readonly size?: number; readonly className?: string }) => {
  const { profile } = useSnapshot()
  return <Face avatar={profile.avatar} size={size} className={className} />
}
