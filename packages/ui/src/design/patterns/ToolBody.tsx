import type { ReactNode } from 'react'
import { Text } from './Settings'
import { GroupLabel } from '../ui/group-label'
import { ToolPaneBody } from '../ui/tool-pane'
import { SectionBody } from '../ui/section'

export const ToolBody = ({ children }: { children: ReactNode }) => <div
  data-slot="tool-body" className="flex min-h-0 min-w-0 flex-1 flex-col">
  <ToolPaneBody data-slot="tool-scroll" inset="tool">{children}</ToolPaneBody>
</div>
export const ToolSection = ({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) => <section
  data-slot="tool-section" aria-label={label} className="min-w-0">
  <GroupLabel as="div" surface="tool"><Text role="meta" weight="medium" ink="secondary">{label}</Text>{action}</GroupLabel>{children}
</section>
export const ToolProse = ({ children }: { children: ReactNode }) => <SectionBody data-slot="tool-prose" spacing="tool-prose"><Text role="prose" ink="secondary">{children}</Text></SectionBody>
