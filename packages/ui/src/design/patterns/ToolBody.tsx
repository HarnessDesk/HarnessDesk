import { createContext, useContext, type ReactNode, type HTMLAttributes } from 'react'
import { Text } from './Settings'
import { GroupLabel } from '../ui/group-label'
import { ToolPaneBody } from '../ui/tool-pane'
import { SectionBody } from '../ui/section'

/** Registered sections share the shell's one scroll owner; standalone bodies keep theirs. */
const SectionsOnly = createContext(false)
export const useToolBodySections = () => useContext(SectionsOnly)
export const ToolBodySections = ({ children }: { children: ReactNode }) => <SectionsOnly.Provider value>{children}</SectionsOnly.Provider>
export const ToolBody = ({ children }: { children: ReactNode }) => useContext(SectionsOnly) ? <>{children}</> : <div
  data-slot="tool-body" className="flex min-h-0 min-w-0 flex-1 flex-col">
  <ToolPaneBody data-slot="tool-scroll" inset="tool">{children}</ToolPaneBody>
</div>
export const ToolSection = ({ label, children, action }: { label: string; children: ReactNode; action?: ReactNode }) => <section
  data-slot="tool-section" aria-label={label} className="min-w-0">
  <GroupLabel as="div" surface="tool"><Text role="meta" weight="medium" ink="secondary">{label}</Text>{action}</GroupLabel>{children}
</section>
/** A missing-fact note uses the row edge and second-line type; prose keeps its reading inset. */
export const ToolProse = ({ children, variant = 'prose' }: { children: ReactNode; variant?: 'prose' | 'note' }) => <SectionBody data-slot="tool-prose" spacing={variant === 'note' ? 'inline' : 'tool-prose'}><Text role={variant === 'note' ? 'meta' : 'prose'} ink="secondary">{children}</Text></SectionBody>

export const ToolBodyControls = ({ children, ...props }: { children: ReactNode } & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style'>) => <div {...props} data-slot="tool-controls" data-surface=""
  className="hd-no-drag flex min-w-0 shrink-0 flex-wrap items-center gap-(--hd-space-2) px-(--hd-inset-row) py-(--hd-space-2)">{children}</div>
