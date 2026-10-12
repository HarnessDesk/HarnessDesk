import type { ComponentProps } from 'react'
import { WorkbenchRail } from './DockPanel'
/** The sign-in boundary's own navigation ground. */
export const SignInRail = ({ className, ...props }: ComponentProps<'nav'>) =>
  <WorkbenchRail as="nav" data-slot="sign-in-rail" className={className} {...props} />
