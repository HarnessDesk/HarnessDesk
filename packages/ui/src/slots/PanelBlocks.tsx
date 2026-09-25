import {
  DisclosureChevron,
  Button,
  Card,
  CardViewport,
  CodeText,
  KeyValue,
  KeyValueRow,
  PatchHeader,
  PopoverGroupLabel,
  Section,
  Separator,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  TextMark,
} from '../design'
import { Suspense, lazy, useMemo, useState, type ReactNode } from 'react'

import type { UiAction, UiBlock, UiPanelData, UiTreeNode } from '@harnessdesk/protocol'

import { useSnapshot, useStore } from '../state/context'
import { useTheme } from '../state/theme'
import { editorLook } from '../lib/editor-prefs'
import { Markdown } from '../components/Markdown'
import { DiffView } from '../components/Diff'
import { BulletIcon, ChevronIcon, TodoDoneIcon, TodoPendingIcon } from '../components/Icons'
import { publishComponent, type SlotProps } from './registry'
import styles from './PanelBlocks.module.css'

/**
 * `hd.panel` — the component plugins reference for a data-driven panel.
 *
 * It renders `UiPanelData` from the contribution and nothing else: no plugin
 * code runs here, and an action button dispatches a plugin *command* over the
 * wire, which executes in the plugin host under the plugin's permissions. The
 * renderer stays untrusted-code-free by construction, not by review.
 *
 * That property is what shapes every block below. `code` is a real CodeMirror
 * view and `diff` is the same view a turn's patch is drawn with — but a
 * plugin supplies only text, a language and a list of line numbers. It cannot
 * reach the editor, register an extension, or hand over a component. Where a
 * block needs to do something, it does it by naming a command, exactly as a
 * button does; there is no second mechanism, because a second mechanism is
 * where the code would eventually get in.
 *
 * The editor is lazy for the same reason `FilePane` loads it lazily: a panel
 * with a `code` block is uncommon, and CodeMirror is a 355 kB chunk that
 * should not be in the paint of a window that usually opens on a
 * conversation.
 */

const CodeEditor = lazy(async () => ({ default: (await import('../components/CodeEditor')).CodeEditor }))

const isPanelData = (value: unknown): value is UiPanelData =>
  typeof value === 'object' && value !== null && Array.isArray((value as UiPanelData).blocks)

/** Runs a block's action, whatever kind of control carried it. */
const useRunner = (): ((action: UiAction | undefined) => void) => {
  const store = useStore()
  return (action) => {
    if (!action) return
    void store.runCommand(action.command, action.argument ?? '')
  }
}

// --------------------------------------------------------------------- code

const CodeBlock = ({ block }: { block: Extract<UiBlock, { type: 'code' }> }) => {
  const theme = useTheme()
  const { editorPrefs } = useSnapshot()
  const appearance = useMemo(() => editorLook(editorPrefs), [editorPrefs])
  const run = useRunner()
  const [draft, setDraft] = useState<string | null>(null)

  // A block that says it is editable but names nothing to run on save would
  // take a person's typing and drop it. Reading the intent as read-only is
  // the honest failure: nothing is lost, and the block still shows its text.
  const editable = block.editable === true && block.onSave !== undefined
  const text = draft ?? block.text
  const maxLines = Math.max(4, Math.trunc(block.maxLines ?? 24))

  return (
    <Card variant="flush" radius="sm" className={styles.code}>
      {(block.path || editable) && (
        <PatchHeader level="block">
          {block.path && <CodeText size="inherit" className="min-w-0 truncate">{block.path}</CodeText>}
          {editable && draft !== null && draft !== block.text && (
            <Text role="meta" ink="secondary" className={styles.codeDirty}>Unsaved — ⌘S</Text>
          )}
        </PatchHeader>
      )}
      <CardViewport size="lines" maxHeight={Math.round(maxLines * appearance.fontSize * appearance.lineHeight)}>
        {/* The text itself while the editor's chunk is in flight, so the
            panel shows the code rather than a blank. */}
        <Suspense fallback={<CodeText as="pre" block>{text}</CodeText>}>
          <CodeEditor
            value={text}
            path={block.path ?? null}
            language={block.language ?? null}
            readOnly={!editable}
            dark={theme === 'dark'}
            look={appearance}
            lineNumbers={editorPrefs.lineNumbers}
            wrap={editorPrefs.wrap}
            tabSize={editorPrefs.tabSize}
            {...(block.decorations ? { decorations: block.decorations } : {})}
            {...(editable
              ? {
                  onChange: setDraft,
                  onSave: () => {
                    const onSave = block.onSave
                    if (!onSave) return
                    // The whole text is the argument: a command contribution
                    // takes one string, and a patch would need the plugin to
                    // know what it had already been sent.
                    run({ ...onSave, argument: draft ?? block.text })
                  },
                }
              : {})}
            ariaLabel={block.path ?? 'Code'}
          />
        </Suspense>
      </CardViewport>
    </Card>
  )
}

// ----------------------------------------------------------------- document

const DocumentSection = ({
  heading,
  text,
  collapsed,
}: {
  heading: string
  text: string
  collapsed?: boolean
}) => {
  const [open, setOpen] = useState(collapsed !== true)
  return (
    <section>
<Button
        type="button"
        variant="row" size="row" className={styles.documentHeading}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <DisclosureChevron open={open} size="sm" className={styles.documentChevron} />
        {heading}
      </Button>
      {open && (
        <Text as="div" role="navigation" className={styles.documentBody}>
          <Markdown text={text} />
        </Text>
      )}
    </section>
  )
}

// --------------------------------------------------------------------- tree

/** A node's label, and its hint at the row's end with a gap before it only when there is one. */
const TreeText = ({ node }: { node: UiTreeNode }) => (
  <span className={styles.treeText}>
    <Text role="navigation" truncate className={styles.treeLabel}>{node.label}</Text>
    {node.hint && <Text role="meta" className={styles.treeHint}>{node.hint}</Text>}
  </span>
)

const TreeNode = ({ node }: { node: UiTreeNode }) => {
  const run = useRunner()
  const children = node.children ?? []
  const [open, setOpen] = useState(node.expanded === true)
  const hasChildren = children.length > 0
  const actionable = node.action !== undefined

  return (
    <li>
      <div className={styles.treeRow}>
        {hasChildren ? (
<Button
            type="button"
            variant="ghost" size="icon-sm" className={styles.treeTwisty}
            aria-expanded={open}
            aria-label={open ? `Collapse ${node.label}` : `Expand ${node.label}`}
            // A node that both folds and acts has two controls in one row, so
            // the twisty must not also fire the action underneath it.
            onClick={(event) => {
              event.stopPropagation()
              setOpen((value) => !value)
            }}
          >
            <DisclosureChevron open={open} size="sm" />
          </Button>
        ) : (
          <span className={styles.treeSpacer} aria-hidden="true" />
        )}
        {actionable ? (
          <Button type="button" variant="row" size="row" className={styles.treeRow} onClick={() => run(node.action)}>
            <TreeText node={node} />
          </Button>
        ) : (
          <TreeText node={node} />
        )}
      </div>
      {hasChildren && open && (
        <ul className={styles.treeChildren}>
          {children.map((child, index) => (
            <TreeNode key={index} node={child} />
          ))}
        </ul>
      )}
    </li>
  )
}

// -------------------------------------------------------------------- block

export const Block = ({ block }: { block: UiBlock }) => {
  const run = useRunner()
  switch (block.type) {
    case 'markdown':
      return (
        <Text as="div" role="navigation">
          <Markdown text={block.text} />
        </Text>
      )
    case 'keyValue':
      return (
        <KeyValue variant="panel" className={styles.keyValue}>
          {block.entries.map((entry, index) => (
            <KeyValueRow key={index} variant="panel" label={entry.label}>{entry.value}</KeyValueRow>
          ))}
        </KeyValue>
      )
    case 'list':
      return (
        <ul className={styles.list}>
          {block.items.map((item, index) => (
            <li key={index} className={styles.listItem}>
              <TextMark>
                {item.done === true ? (
                  <TodoDoneIcon size={12} />
                ) : item.done === false ? (
                  <TodoPendingIcon size={12} />
                ) : (
                  <BulletIcon size={16} />
                )}
              </TextMark>
              <Text role="navigation" done={item.done === true} className={styles.listLabel}>
                {item.label}
                {item.hint && <Text role="meta" className="ml-1.5">{item.hint}</Text>}
              </Text>
            </li>
          ))}
        </ul>
      )
    case 'actions':
      return (
        <div className={styles.actions}>
          {block.actions.map((action, index) => (
<Button
              key={index}
              type="button"
              variant="ghost" size="icon-sm"
              onClick={() => run(action)}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )
    case 'code':
      return <CodeBlock block={block} />
    case 'document':
      return (
        <div className={styles.document}>
          {block.title && <Text as="div" role="row" className="mb-1">{block.title}</Text>}
          {block.sections.map((section, index) => (
            <div key={index}>
              {index > 0 && <Separator />}
              <DocumentSection
                heading={section.heading}
                text={section.text}
                {...(section.collapsed !== undefined ? { collapsed: section.collapsed } : {})}
              />
            </div>
          ))}
        </div>
      )
    case 'table':
      return (
        // Wide tables scroll inside the panel; the panel itself never grows a
        // horizontal scrollbar, because the sidebar it sits in cannot.
        <Table variant="panel" containerClassName={styles.tableScroll}>
            {block.caption && <TableCaption variant="panel">{block.caption}</TableCaption>}
            <TableHeader>
              <TableRow variant="panel">
                {block.columns.map((column) => (
                  <TableHead
                    key={column.key}
                    scope="col"
                    variant="panel"
                    align={column.align === 'end' ? 'end' : 'start'}
                  >
                    {column.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {block.rows.map((row, index) => (
                <TableRow key={index} variant="panel">
                  {block.columns.map((column) => (
                    <TableCell
                      key={column.key}
                      variant="panel"
                      align={column.align === 'end' ? 'end' : 'start'}
                    >
                      {/* Keyed, not positional: a cell the row omits is empty, never the next column's. */}
                      {row[column.key] ?? ''}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
        </Table>
      )
    case 'tree':
      return (
        <ul className={styles.tree}>
          {block.nodes.map((node, index) => (
            <TreeNode key={index} node={node} />
          ))}
        </ul>
      )
    case 'diff':
      return (
        <Card variant="flush" radius="sm" className={styles.diff}>
          {block.path && <PatchHeader level="block"><CodeText size="inherit" className="min-w-0 truncate">{block.path}</CodeText></PatchHeader>}
          <DiffView diff={block.patch} {...(block.wholeFile ? { wholeFile: true } : {})} />
        </Card>
      )
    default:
      return null
  }
}

/**
 * The chrome around a panel in a fixed slot: a title that folds it away, and
 * a body that scrolls inside its own height.
 *
 * Both exist for the same reason. The sidebar is one column, and a panel with
 * nine tasks in it took half of that column away from the session list with
 * no scrollbar of its own and no way to put it down. A panel is now at most a
 * few rows tall before it scrolls, and its title is the control that folds
 * it — which is where a person reaches for one.
 *
 * `id` is what the fold is remembered under, so it must be stable across the
 * panel's own updates: a plugin re-registers its panel to change the data,
 * and a fold keyed on the contribution id would spring open every time the
 * agent ticked a task off.
 */
export const PanelSection = ({
  id,
  title,
  children,
}: {
  id: string
  title: string | undefined
  children: ReactNode
}) => {
  const store = useStore()
  const collapsed = useSnapshot().listPrefs.panelsCollapsed
  const open = !collapsed.includes(id)
  const toggle = (): void => {
    store.setListPrefs({
      panelsCollapsed: open ? [...collapsed, id] : collapsed.filter((entry) => entry !== id),
    })
  }

  return (
    <Section variant="panel" className={styles.section} aria-label={title}>
      {title && (
<Button
          type="button"
          variant="row" size="row" className={styles.sectionTitle}
          aria-expanded={open}
          title={open ? `Hide ${title}` : `Show ${title}`}
          onClick={toggle}
        >
          <span className={styles.sectionChevron} data-chevron data-open={open ? '' : undefined} aria-hidden="true">
            <ChevronIcon size={11} />
          </span>
          <PopoverGroupLabel inset={false}>{title}</PopoverGroupLabel>
        </Button>
      )}
      {/* A title-less panel has no way to unfold itself, so it never folds. */}
      {(open || !title) && <div className={styles.sectionBody}>{children}</div>}
    </Section>
  )
}

const Panel = ({ contribution }: SlotProps) => {
  const data = contribution?.kind === 'ui' ? contribution.data : undefined
  if (!isPanelData(data)) return null
  return (
    <PanelSection
      /* The owner and the label, never the contribution id: the id is
         reissued on every update the plugin makes. */
      id={`${String(contribution?.owner ?? '')}:${contribution?.kind === 'ui' ? contribution.label : ''}`}
      title={data.title}
    >
      {data.blocks.map((block, index) => (
        <Block key={index} block={block} />
      ))}
    </PanelSection>
  )
}

/** Called once at startup; the id is what plugin manifests reference. */
export const installPanelComponent = (): void => {
  publishComponent('hd.panel', Panel)
}
