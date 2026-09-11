import { Face } from '../design/primitives/Kit'
import { useSnapshot } from '../state/context'

/**
 * Your own face, as the profile has it: the design system's `Face`, reading
 * the store. One subscription per face drawn — a surface that already holds
 * the snapshot, or draws you many times, passes `profile.avatar` to `Face`.
 */
export const ProfileFace = ({ size, className }: { readonly size?: number; readonly className?: string }) => {
  const { profile } = useSnapshot()
  return <Face avatar={profile.avatar} size={size} className={className} />
}
