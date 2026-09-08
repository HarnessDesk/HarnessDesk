import { BrandMark } from '@/components/BrandIcons'
import { BranchIcon, FileIcon, HistoryIcon, ImageIcon } from '@/components/Icons'
import {
  Approval,
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  Button,
  CodeBlock,
  DiffBlock,
  FileRow,
  Marker,
  MarkerContent,
  MarkerIcon,
  Problem,
  Prose,
  Thinking,
  Todos,
  Turn,
  Work,
  WorkStep,
} from '../ui'
import styles from './conversation-page.module.css'

/**
 * One transcript, carrying every kind of thing a transcript can carry.
 *
 * Deliberately not a tidy sample. Real turns are ugly: an agent reads eleven
 * files, thinks, publishes a plan, runs a command that fails, retries, asks for
 * permission, pastes a diff, and answers — and the design is only worth
 * anything if it survives all of that in one column, at one width, in one
 * reading. So this page is one continuous conversation with every block in it,
 * in the order they actually turn up, rather than a grid of specimens with air
 * between them.
 *
 * What it is testing, specifically:
 *
 *   Does the answer still stand out    with nine steps folded above it?
 *   Does the failure still find you    when it is the fourth of six steps?
 *   Does the approval still stop you   scrolling past at speed?
 *   Does the diff stay readable        inside a step, inside a fold, inside a
 *                                      column 700px wide?
 *
 * If any of those is no, the grading in `turn.tsx` is wrong, and this is where
 * it shows.
 */

const DIFF = [
  { kind: 'hunk' as const, text: '@@ -12,7 +12,9 @@ export const authorise = (' },
  { kind: 'context' as const, text: '  const token = readToken(request)' },
  { kind: 'remove' as const, text: '  if (!token) return null' },
  { kind: 'add' as const, text: '  if (!token) throw new Unauthorised()' },
  { kind: 'add' as const, text: '' },
  { kind: 'context' as const, text: '  return verify(token)' },
]

export const ConversationPage = () => (
  <div className={styles.column}>
    <Marker variant="separator">
      <MarkerIcon>
        <HistoryIcon />
      </MarkerIcon>
      <MarkerContent>Resumed · 42 turns before this</MarkerContent>
    </Marker>

    <Turn role="you">
      The auth callers still use the old signature. Migrate them, but leave anything outside
      src/api alone — Codex has the gateway.
    </Turn>

    <Turn
      author="Claude Code"
      mark={<BrandMark brand="claudecode" size={14} />}
      tint="blue"
      at="09:28"
    >
      <Thinking summary="Thought for 8s">
        Fifteen call sites. The signature change is mechanical, but three of them pass the token
        positionally, so a blind replace would compile and be wrong. Worth reading those three
        before touching anything.
      </Thinking>

      <Todos
        items={[
          { text: 'Find every caller of authorise()', state: 'done' },
          { text: 'Migrate the twelve mechanical ones', state: 'done' },
          { text: 'Read the three positional callers by hand', state: 'active' },
          { text: 'Run the suite', state: 'pending' },
        ]}
      />

      <Work summary="Worked for 1m 14s · read 6 files, ran 2 commands, edited 14">
        <WorkStep
          kind="search"
          verb="Searched"
          object="authorise\\("
          meta="15 hits"
          wire="mcp__harnessdesk__grep"
          detail={
            <CodeBlock>{`src/api/session.ts:41
src/api/workspace.ts:88
src/api/agents.ts:12
… 12 more`}</CodeBlock>
          }
        />
        <WorkStep kind="read" verb="Read" object="src/api/session.ts" meta="0.2s" />
        <WorkStep kind="read" verb="Read" object="src/api/workspace.ts" meta="0.2s" />
        <WorkStep
          kind="edit"
          verb="Edited"
          object="src/api/session.ts"
          meta="+2 −1"
          detail={<DiffBlock file="src/api/session.ts" added={2} removed={1} lines={DIFF} />}
        />
        <WorkStep
          kind="run"
          verb="Ran"
          object="pnpm --filter @harnessdesk/server test"
          state="failed"
          meta="18.4s"
          detail={
            <CodeBlock stream="stderr">{`FAIL  test/auth.test.ts > rejects an absent token
  expected Unauthorised, received null

  at authorise (src/api/legacy.ts:31:9)`}</CodeBlock>
          }
        />
        <WorkStep
          kind="run"
          verb="Ran"
          object="rm -rf packages/server/dist"
          state="declined"
          meta="—"
          wire="shell"
          detail={
            <p className="text-xs text-(--hd-secondary-foreground)">
              Refused by the workspace rule: a recursive delete outside the scratch directory needs
              a decision every time.
            </p>
          }
        />
        <WorkStep kind="run" verb="Ran" object="pnpm --filter @harnessdesk/server test" meta="16.1s" />
      </Work>

      <Prose>
        <p>
          Fourteen callers migrated and the suite is green. The failure above was real: one caller
          in <code>packages/server/src/api/legacy.ts</code> still returns <code>null</code> rather
          than throwing, and it is outside the paths you gave me — so I have left it alone and it
          is the one file below marked untouched.
        </p>
        <p>Three of the fifteen passed the token positionally and needed reading rather than replacing.</p>
      </Prose>

      <div className={styles.files}>
        <FileRow status="M" path="src/api/session.ts" added={2} removed={1} />
        <FileRow status="M" path="src/api/workspace.ts" added={4} removed={4} />
        <FileRow status="A" path="src/api/errors.ts" added={18} removed={0} />
        <FileRow status="D" path="src/api/legacy-shim.ts" added={0} removed={31} />
      </div>
    </Turn>

    <Turn role="you">
      Take the last one too. Here is what the reviewer flagged.
      {/* The registry's attachment, with the states our own never had: a file
          part-way up, one the desk is still chewing on, and one that failed
          with its reason on the row rather than in a toast that has gone. */}
      <AttachmentGroup className={styles.attachments}>
        <Attachment state="done">
          <AttachmentMedia variant="image">
            <ImageIcon aria-hidden />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>review-comment.png</AttachmentTitle>
            <AttachmentDescription>PNG · 184 KB</AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction aria-label="Remove review-comment.png" />
          </AttachmentActions>
        </Attachment>
        <Attachment state="uploading" progress={54}>
          <AttachmentMedia />
          <AttachmentContent>
            <AttachmentTitle>trace.har</AttachmentTitle>
            <AttachmentDescription>Uploading · 54%</AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction aria-label="Cancel upload" />
          </AttachmentActions>
        </Attachment>
        <Attachment state="error">
          <AttachmentMedia />
          <AttachmentContent>
            <AttachmentTitle>legacy.ts</AttachmentTitle>
            <AttachmentDescription>Too large — 24 MB of 8 MB</AttachmentDescription>
          </AttachmentContent>
          <AttachmentActions>
            <AttachmentAction aria-label="Remove legacy.ts" />
          </AttachmentActions>
        </Attachment>
      </AttachmentGroup>
    </Turn>

    <Turn
      author="Claude Code"
      mark={<BrandMark brand="claudecode" size={14} />}
      tint="blue"
      at="09:36"
    >
      <Approval
        title="Edit a file outside this session's paths?"
        detail="packages/server/src/api/legacy.ts"
      >
        <Button size="sm">Allow once</Button>
        <Button size="sm" variant="outline">
          Always allow in this workspace
        </Button>
        <Button size="sm" variant="ghost">
          Deny
        </Button>
      </Approval>
    </Turn>

    <Marker variant="separator">
      <MarkerContent>Context compacted · 118k → 24k tokens</MarkerContent>
    </Marker>

    <Turn
      author="Codex"
      mark={<BrandMark brand="codex" size={14} />}
      tint="teal"
      at="09:41"
    >
      <Work summary="Worked for 6s · fetched 1 page" trouble>
        <WorkStep
          kind="web"
          verb="Fetched"
          object="https://internal.example.com/runbooks/auth"
          state="failed"
          meta="timeout"
          wire="web_fetch"
          detail={
            <CodeBlock stream="stderr">ETIMEDOUT after 30s — host unreachable from this network</CodeBlock>
          }
        />
      </Work>
      <Problem title="The turn stopped before it finished">
        The runbook is on the internal network, which this desk cannot reach. Paste the relevant
        section and I will carry on from there.
      </Problem>
    </Turn>

    <Turn
      author="Cursor"
      mark={<BrandMark brand="cursor" size={14} />}
      tint="violet"
      at="09:44"
    >
      <Work summary="Working · reading src/api" running>
        <WorkStep kind="read" verb="Reading" object="src/api/agents.ts" state="running" />
      </Work>
    </Turn>

    <Marker variant="separator">
      <MarkerContent>Today</MarkerContent>
    </Marker>

    {/* The two variants the app did not have before: an inline note in the
        flow, and a bordered row for a boundary that is still a row. */}
    <Marker>
      <MarkerIcon>
        <BranchIcon />
      </MarkerIcon>
      <MarkerContent>Switched to feat/auth-migration</MarkerContent>
    </Marker>
    <Marker variant="border">
      <MarkerIcon>
        <FileIcon />
      </MarkerIcon>
      <MarkerContent>Explored 4 files</MarkerContent>
    </Marker>
  </div>
)
