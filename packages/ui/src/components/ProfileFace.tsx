import { PersonFace } from '../design'
import { useSnapshot } from '../state/context'

/** Current signed-in person, independent of application artwork. */
export const ProfileFace = ({ size, className }: { readonly size?: number; readonly className?: string }) => {
  const { harnessDeskAccount } = useSnapshot()
  return <PersonFace pictureDataUrl={harnessDeskAccount?.status === 'signedIn' ? harnessDeskAccount.account?.pictureDataUrl : null} size={size} className={className} />
}
