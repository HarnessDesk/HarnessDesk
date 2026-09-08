import {
  AnnotateIcon,
  CameraIcon,
  DevToolsIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  GlobeIcon,
  MobileIcon,
  PlusIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
} from '@/components/Icons'
import {
  Badge,
  BrowserChrome,
  Button,
  CodeBlock,
  EmptyState,
  ListRow,
  ListRows,
  Progress,
  ToolPane,
  ToolPaneBody,
  ToolPaneHeader,
  ToolPaneTab,
  ToolPaneTabs,
  Tabs,
  TabsContent,
} from '../ui'
import styles from './tools-page.module.css'

/**
 * The tools, in the frame they share.
 *
 * A desk that drives agents ends up owning half an IDE — a terminal, a browser,
 * an editor, a file tree, a console — and the failure mode is not that any one
 * of them is bad. It is that five people build five panes and the browser's
 * reload sits two pixels off where the terminal's stop sits, the editor's tab
 * strip is a different height from the browser's, and one of them padded its
 * body while the others did not.
 *
 * So every pane here is the same `ToolPane`: one header with a mark, a name, a
 * subject and its actions; one body that either pads or bleeds. What differs
 * between them is only what a terminal genuinely is versus what a browser
 * genuinely is — which is the difference worth seeing, and the only one this
 * page shows.
 *
 * The rule the header encodes: **the subtitle is the pane's subject, and it is
 * always earned**. A terminal without its working directory, a browser without
 * its origin, an editor without its path — each is a pane you cannot trust,
 * because you cannot tell what it is showing. That is the exception the
 * second-line rule allows for: a fact that varies, which the title cannot carry.
 */

export const ToolsPage = () => (
  <div className={styles.paneGrid}>
    {/* --- the browser ---------------------------------------------------- */}
    <ToolPane className={styles.paneTall}>
      <ToolPaneHeader
        icon={<GlobeIcon />}
        title="Browser"
        subtitle="driven by Claude Code"
        actions={
          <>
            <Button variant="ghost" size="icon-sm" aria-label="Annotate">
              <AnnotateIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Screenshot">
              <CameraIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Responsive">
              <MobileIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Console">
              <DevToolsIcon />
            </Button>
          </>
        }
      />
      {/* A real Tabs root: Base UI owns which tab is current, gives the strip
          arrow-key navigation, and wires each tab to its panel. The `+` is
          deliberately outside the list — opening a tab is not one of the
          things you can be *on*, and giving it `role="tab"` told every screen
          reader that it was. */}
      <Tabs defaultValue="preview" className="min-h-0 flex-1 gap-0">
        <div className="flex items-center border-b border-(--hd-border) pr-1.5">
          <ToolPaneTabs className="min-w-0 flex-1 border-b-0">
            <ToolPaneTab value="preview" icon={<GlobeIcon />} onClose={() => undefined}>
              localhost:5273
            </ToolPaneTab>
            <ToolPaneTab value="docs" icon={<GlobeIcon />} onClose={() => undefined}>
              Design system docs
            </ToolPaneTab>
          </ToolPaneTabs>
          <Button variant="ghost" size="icon-sm" aria-label="New tab">
            <PlusIcon />
          </Button>
        </div>
        <BrowserChrome
          origin="localhost:5273"
          url="/design.html#board=stat"
          loading
          onBack={() => undefined}
          onReload={() => undefined}
        />
        <TabsContent value="preview" className="min-h-0 overflow-auto">
          <div className={styles.viewport} aria-label="Page being driven">
            <div className={styles.viewportBar} style={{ width: '40%' }} />
            <div className={styles.viewportBar} style={{ width: '65%' }} />
            <div className={styles.viewportBlock} />
          </div>
        </TabsContent>
        <TabsContent value="docs" className="min-h-0 overflow-auto">
          <div className={styles.viewport} aria-label="Page being driven">
            <div className={styles.viewportBar} style={{ width: '55%' }} />
            <div className={styles.viewportBlock} />
          </div>
        </TabsContent>
      </Tabs>
    </ToolPane>

    {/* --- the browser, when the page is not ours -------------------------- */}
    <ToolPane className={styles.paneTall}>
      <ToolPaneHeader icon={<GlobeIcon />} title="Browser" subtitle="console" />
      <BrowserChrome origin="staging.example.com" url="/checkout?step=2" secure={false} />
      <ToolPaneBody>
        <ListRows>
          <ListRow
            size="sm"
            lead={<Badge variant="destructive">error</Badge>}
            title="Uncaught TypeError: cart.items is undefined"
            subtitle="checkout.js:214"
            trail="3×"
          />
          <ListRow
            size="sm"
            lead={<Badge variant="secondary">warn</Badge>}
            title="Mixed content: an image was loaded over HTTP"
            subtitle="checkout.js:88"
          />
          <ListRow
            size="sm"
            lead={<Badge variant="outline">log</Badge>}
            title="cart hydrated in 412ms"
            subtitle="checkout.js:19"
          />
        </ListRows>
      </ToolPaneBody>
    </ToolPane>

    {/* --- the terminal ---------------------------------------------------- */}
    <ToolPane className={styles.pane}>
      <ToolPaneHeader
        icon={<TerminalIcon />}
        title="Terminal"
        subtitle="~/code/harnessdesk"
        actions={
          <>
            <Button variant="ghost" size="sm">
              <StopIcon /> Stop
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Clear">
              <TrashIcon />
            </Button>
          </>
        }
      />
      <ToolPaneBody bleed>
        <div className={styles.terminal}>
          <span className={styles.terminalPrompt}>❯</span> pnpm --filter @harnessdesk/ui test{'\n'}
          <span className={styles.terminalDim}>
            {' RUN  v3.2.7 /Users/…/packages/ui\n\n'}
          </span>
          {' ✓ src/design/tokens.contrast.test.ts (5 tests)\n'}
          {' ✓ src/design/ui/button.test.tsx (2 tests)\n\n'}
          {' Test Files  94 passed (94)\n'}
          {'      Tests  1023 passed (1023)\n\n'}
          <span className={styles.terminalPrompt}>❯</span>{' '}
          <span className="animate-pulse">▌</span>
        </div>
      </ToolPaneBody>
    </ToolPane>

    {/* --- the editor ------------------------------------------------------ */}
    <ToolPane className={styles.pane}>
      <ToolPaneHeader
        icon={<FileIcon />}
        title="Editor"
        subtitle="src/design/ui/tone.ts"
        actions={
          <Button size="sm" variant="outline">
            Save
          </Button>
        }
      />
      <Tabs defaultValue="tone" className="min-h-0 flex-1 gap-0">
        <ToolPaneTabs>
          <ToolPaneTab value="tone" icon={<FileIcon />} onClose={() => undefined}>
            tone.ts
          </ToolPaneTab>
          <ToolPaneTab value="stat" icon={<FileIcon />} onClose={() => undefined}>
            stat.tsx
          </ToolPaneTab>
        </ToolPaneTabs>
        <TabsContent value="tone" className="min-h-0 overflow-auto p-2.5">
          <CodeBlock language="typescript" className="max-h-none">{`export type Tone =
  | 'neutral'
  | 'brand'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'

/** Which thing this is, said in colour. Carries no judgement. */
export type Tint =
  | 'blue' | 'green' | 'amber' | 'violet'
  | 'rose' | 'teal' | 'orange' | 'sky'`}</CodeBlock>
        </TabsContent>
        <TabsContent value="stat" className="min-h-0 overflow-auto p-2.5">
          <CodeBlock language="typescript" className="max-h-none">{`const statVariants = cva('flex gap-3', {
  variants: {
    variant: {
      plain: 'p-0',
      bordered: 'rounded-(--hd-radius) border …',
      tinted: 'rounded-(--hd-radius) p-4',
    },
  },
})`}</CodeBlock>
        </TabsContent>
      </Tabs>
    </ToolPane>

    {/* --- the file tree --------------------------------------------------- */}
    <ToolPane className={styles.pane}>
      <ToolPaneHeader icon={<FolderIcon />} title="Files" subtitle="packages/ui/src/design" />
      <ToolPaneBody className="p-1.5">
        <ListRows size="sm">
          <ListRow size="sm" interactive lead={<FolderOpenIcon aria-hidden className="size-4 text-(--hd-muted-foreground)" />} title="ui" trail="28" />
          <ListRow size="sm" interactive selected lead={<FileIcon aria-hidden className="size-4 text-(--hd-muted-foreground)" />} title="tone.ts" className="ml-4" />
          <ListRow size="sm" interactive lead={<FileIcon aria-hidden className="size-4 text-(--hd-muted-foreground)" />} title="stat.tsx" className="ml-4" />
          <ListRow size="sm" interactive lead={<FileIcon aria-hidden className="size-4 text-(--hd-muted-foreground)" />} title="turn.tsx" className="ml-4" />
          <ListRow size="sm" interactive lead={<FolderIcon aria-hidden className="size-4 text-(--hd-muted-foreground)" />} title="patterns" trail="2" />
          <ListRow size="sm" interactive lead={<FileIcon aria-hidden className="size-4 text-(--hd-muted-foreground)" />} title="tokens.css" />
        </ListRows>
      </ToolPaneBody>
    </ToolPane>

    {/* --- a pane with nothing in it yet ----------------------------------- */}
    <ToolPane className={styles.pane}>
      <ToolPaneHeader icon={<TerminalIcon />} title="Terminal" />
      <ToolPaneBody className="grid place-items-center">
        <EmptyState
          tight
          icon={<TerminalIcon />}
          title="No shell running"
          description="A terminal opens where the session's workspace is."
        >
          <Button size="sm" className="mx-auto w-fit">
            <PlusIcon /> Start a shell
          </Button>
        </EmptyState>
      </ToolPaneBody>
    </ToolPane>

    {/* --- a long-running job ---------------------------------------------- */}
    <ToolPane className={styles.pane}>
      <ToolPaneHeader
        icon={<TerminalIcon />}
        title="Background"
        subtitle="pnpm build — started 09:31"
        actions={
          <Button variant="ghost" size="sm">
            <StopIcon /> Stop
          </Button>
        }
      />
      <ToolPaneBody>
        <Progress value={68} label="68% · 14 of 20 packages" className="mb-3" />
        <CodeBlock className="max-h-none">{`packages/protocol      built  1.2s
packages/codex         built  3.8s
packages/server        building…`}</CodeBlock>
      </ToolPaneBody>
    </ToolPane>
  </div>
)
