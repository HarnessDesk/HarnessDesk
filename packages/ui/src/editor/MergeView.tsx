import { EditorSurface, type CodeViewProps } from './CodeView'
import type { ChangeCounts } from './counts'

export interface MergeViewProps extends CodeViewProps {
  /** The complete file at HEAD, or the disk snapshot for conflict Compare. */
  readonly original: string
  readonly onCountsChange?: (counts: ChangeCounts) => void
}

/** Editable unified comparison with CodeView's lifecycle and editing contract. */
export const MergeView = (props: MergeViewProps) => <EditorSurface {...props} />
