import { ToolPane, ToolPaneMessage } from '../design'
import { useMount } from '../panels/mount'
import { FilePane, type FilePaneProps } from './FilePane'

/** Markdown uses the shared document; HTML/PDF retain their native ticket previews. */
export const PreviewPane = (props: FilePaneProps) => {
  const mount = useMount()
  if (mount?.view.kind !== 'preview') return null
  if (!/\.(html?|pdf|md|markdown)$/i.test(mount.view.path)) return <ToolPane variant="integrated"><ToolPaneMessage>Only HTML, PDF and Markdown files have a preview.</ToolPaneMessage></ToolPane>
  return <FilePane {...props} />
}
