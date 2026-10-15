import { forwardRef, type ComponentProps, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

import { Button } from '../ui/button'
import { DialogContent } from '../ui/dialog'
import { EmptyState } from '../ui/empty-state'
import { Separator } from '../ui/separator'
import { Keycap, NavigationList, Search, Text } from './Settings'
import styles from './CommandPalette.module.css'

type PanelProps = Omit<ComponentProps<typeof DialogContent>, 'bleed' | 'inset' | 'placement' | 'viewportBounded' | 'width'>

/** The fixed, viewport-bounded surface shared by the search palette. */
export const CommandPalettePanel = forwardRef<HTMLDivElement, PanelProps>(
  ({ className, ...props }, ref) => (
    <DialogContent
      {...props}
      ref={ref}
      bleed
      inset="dialog"
      placement="top"
      viewportBounded
      width="wide"
      className={cn(styles.surface, className)}
    />
  ),
)
CommandPalettePanel.displayName = 'CommandPalettePanel'

/** Header search without a second box or icon inset inside the panel. */
export const CommandPaletteSearch = (props: ComponentProps<typeof Search>) => (
  <Search {...props} size="bare" icon="none" className={cn(styles.search, props.className)} />
)

/** Type tabs and their tool-output filter share one toolbar row. */
export const CommandPaletteControls = ({ children }: { children: ReactNode }) => (
  <div className={styles.controls}>{children}</div>
)

/** Divider between the search controls, results and keyboard hints. */
export const CommandPaletteDivider = (props: ComponentProps<typeof Separator>) => (
  <Separator {...props} className={cn(styles.separator, props.className)} />
)

/** Scrollable result list, inset to the panel's content edge. */
export const CommandPaletteResults = forwardRef<HTMLDivElement, ComponentProps<typeof NavigationList>>(
  ({ className, ...props }, ref) => (
    <NavigationList {...props} ref={ref} className={cn(styles.results, className)} />
  ),
)
CommandPaletteResults.displayName = 'CommandPaletteResults'

type ResultProps = Omit<ComponentProps<typeof Button>, 'children' | 'size' | 'variant'> & {
  readonly icon: ReactNode
  readonly label: ReactNode
  readonly meta?: ReactNode
  readonly metaInk?: 'secondary' | 'muted'
  readonly match?: ReactNode
}

/** A title-led palette result with a trailing, right-aligned fact. */
export const CommandPaletteResult = forwardRef<HTMLButtonElement, ResultProps>(
  ({ className, icon, label, meta, metaInk = 'muted', match, ...props }, ref) => (
    <Button
      {...props}
      ref={ref}
      type="button"
      variant="row"
      size="navigation-edge"
      className={cn(styles.result, className)}
      data-palette-result=""
    >
      <Text role="meta" className={styles.resultIcon} data-palette-result-icon="">{icon}</Text>
      <Text as="span" role="subject" ink="primary" className={styles.resultTitle} data-palette-result-title="">{label}</Text>
      {meta != null && (
        <Text
          as="span"
          role={metaInk === 'secondary' ? 'meta' : 'muted'}
          ink={metaInk}
          className={styles.resultMeta}
          data-palette-result-meta=""
        >
          {meta}
        </Text>
      )}
      {match != null && <Text role="meta" className={styles.resultMatch}>{match}</Text>}
    </Button>
  ),
)
CommandPaletteResult.displayName = 'CommandPaletteResult'

/** An inline empty result state that stays on the list's reading edge. */
export const CommandPaletteEmpty = ({ children }: { children: ReactNode }) => (
  <EmptyState variant="inline" title={children} />
)

/** The compact keyboard-hint footer below the result list. */
export const CommandPaletteFooter = ({ children }: { children: ReactNode }) => (
  <div className={styles.footer} aria-label="Keyboard hints">{children}</div>
)

/** A named action and the key that invokes it. */
export const CommandPaletteKeyHint = ({ label, keyName }: { label: string; keyName: string }) => (
  <span className={styles.keyHint}><Text role="meta">{label}</Text><Keycap>{keyName}</Keycap></span>
)
