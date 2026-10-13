import { Markdown } from '../components/Markdown'

export interface MarkdownViewProps {
  readonly text: string
  readonly className?: string
}

/** File Markdown keeps the canonical renderer and its sanitizer in one place. */
export const MarkdownView = ({ text, className }: MarkdownViewProps) => (
  <div className={className}><Markdown text={text} document /></div>
)
