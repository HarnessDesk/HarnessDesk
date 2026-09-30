import { useState } from 'react'

import { runtimeId, sessionKey } from '@harnessdesk/protocol'

import { BrowserPane } from '../components/BrowserPane'
import { Conversation } from '../components/Conversation'
import { ExpandIcon, MoreIcon } from '../components/Icons'
import { MountProvider } from '../panels/mount'
import { PaneProvider, StoreProvider } from '../state/context'
import { Button, Chip, Monogram, Segmented, Text, Textarea } from '../design'
import { Frame } from './main'
import { previewStore, runtime } from './harness'
import { previewSession } from './sidebar-fixture'

const MEMBERS = [
  { name: 'Alpha', mark: 'A', model: 'Model 1', state: 'Working', time: '01:42', cost: '$0.08' },
  { name: 'Beta', mark: 'B', model: 'Model 2', state: 'Done', time: '02:18', cost: '$0.11' },
  { name: 'Gamma', mark: 'G', model: 'Model 3', state: 'Waiting for you', time: '01:56', cost: '$0.09' },
  { name: 'Delta', mark: 'D', model: 'Model 4', state: 'Done', time: '02:31', cost: '$0.13' },
] as const

const TILE_STORES = new Map(MEMBERS.map((member) => {
  const id = runtimeId(member.name.toLowerCase())
  const key = sessionKey(id, previewSession.id)
  const options = (previewSession.options ?? []).map((option) => option.id === 'model'
    ? { ...option, currentValue: member.model, choices: [{ value: member.model, label: member.model }] }
    : option)
  const session = {
    ...previewSession,
    runtime: id,
    settings: { ...previewSession.settings, agent: undefined, model: member.model },
    options,
  }
  const tileStore = previewStore({
    runtimes: [runtime(id, member.name)],
    sessions: new Map([[key, session as typeof previewSession]]),
    activeSessionKey: key,
    activeRuntime: id,
  })
  return [member.mark, { key, store: tileStore }] as const
}))

const SNAKE_PAGE = `<!doctype html><meta charset="utf-8"><title>Snake</title><style>body{margin:0;background:#101a23;color:#e8f3ee;font:14px system-ui;display:grid;place-items:center;height:100vh}canvas{width:360px;height:360px;max-width:80vw;max-height:70vh;border:1px solid #456;background:#14232a}main{text-align:center}p{color:#a8bdb4}</style><main><h2>Snake</h2><canvas id="game" width="360" height="360"></canvas><p>Use the arrow keys · score 12</p></main><script>const c=document.querySelector('canvas'),x=c.getContext('2d'),s=20;for(let r=0;r<18;r++)for(let q=0;q<18;q++){x.fillStyle=(r+q)%2?'#1a2b31':'#1d3036';x.fillRect(q*s,r*s,s,s)}x.fillStyle='#54d68b';[[5,9],[6,9],[7,9],[8,9],[9,9]].forEach(([a,b])=>x.fillRect(a*s+1,b*s+1,s-2,s-2));x.fillStyle='#f0b84b';x.beginPath();x.arc(13*s+10,6*s+10,7,0,Math.PI*2);x.fill()</script>`
const SNAKE_URL = `data:text/html,${encodeURIComponent(SNAKE_PAGE)}`

type TileProps = {
  readonly member: (typeof MEMBERS)[number]
  readonly browser?: boolean
  readonly picked?: boolean
  readonly expanded?: boolean
}

const Tile = ({ member, browser = false, picked = false, expanded = false }: TileProps) => {
  const [view, setView] = useState<'conversation' | 'browser'>(browser ? 'browser' : 'conversation')
  const { key, store } = TILE_STORES.get(member.mark)!
  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <div className="flex min-h-(--hd-bar-h) shrink-0 items-center gap-2 border-b border-border px-3">
        <Monogram>{member.mark}</Monogram>
        <Text role="subject" className="truncate">{member.name}</Text>
        <Text role="meta" className="truncate">{member.model}</Text>
        <Chip tone="neutral" size="sm">{member.state}</Chip>
        {picked && <Chip tone="brand" emphasis size="sm">Picked</Chip>}
        <span className="ml-auto flex items-center gap-2 whitespace-nowrap">
          <Text role="meta">{member.time}</Text><Text role="meta">{member.cost}</Text>
        </span>
        <Segmented
          label={`${member.name} view`}
          value={view}
          onChange={(next) => setView(next as 'conversation' | 'browser')}
          options={[{ value: 'conversation', label: 'Conversation' }, { value: 'browser', label: 'Browser' }]}
        />
        {expanded && <Text role="meta">Esc to return</Text>}
        <Button variant="ghost" size="icon" aria-label="Expand tile"><ExpandIcon size={14} /></Button>
        <Button variant="ghost" size="icon" aria-label="More options"><MoreIcon size={14} /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === 'browser' ? (
          <MountProvider scope={{ area: 'main', id: `race-browser-${member.mark}`, view: { kind: 'browser', tabs: [{ id: 'snake', url: SNAKE_URL }], active: 'snake', driven: 'snake' } }}>
            <div className="h-full min-h-0"><BrowserPane /></div>
          </MountProvider>
        ) : (
          <div className={`${expanded ? 'h-full' : 'h-[760px]'} overflow-hidden [&>div>header]:hidden`}>
            <StoreProvider store={store}>
              <MountProvider scope={{ area: 'main', id: `race-conversation-${member.mark}`, view: { kind: 'conversation', session: key } }}>
                <PaneProvider scope={{ paneId: `race-${member.mark}` as never, view: { kind: 'conversation', session: key } as never, sessionKey: key }}>
                  <Conversation onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} />
                </PaneProvider>
              </MountProvider>
            </StoreProvider>
          </div>
        )}
      </div>
    </section>
  )
}

const Rail = () => (
  <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
    <div className="border-b border-border p-3"><Text role="subject">Snake game race</Text></div>
    <nav className="grid gap-1 p-2" aria-label="Room destinations">
      {['Board', 'Chat', 'Side by side', 'Findings'].map((name) => (
        <Button key={name} variant={name === 'Side by side' ? 'secondary' : 'ghost'} className="justify-start">{name}</Button>
      ))}
    </nav>
    <div className="border-t border-border p-3">
      <Text role="meta">MEMBERS</Text>
      <div className="mt-2 grid gap-2">
        {MEMBERS.map((member) => <div key={member.name} className="flex items-center gap-2"><Monogram>{member.mark}</Monogram><Text>{member.name}</Text></div>)}
      </div>
    </div>
  </aside>
)

const RoomComposerMock = () => (
  <div className="absolute bottom-3 left-1/2 z-10 w-[min(680px,70%)] -translate-x-1/2 rounded-lg border border-border bg-card p-3 shadow-md">
    <div className="mb-2 flex items-center gap-2"><Chip tint="blue" size="sm">Everyone</Chip><Text role="meta">One message to all four</Text></div>
    <Textarea aria-label="Room message" readOnly value="Add a high-score counter that survives a restart" className="min-h-14 resize-none" />
    <div className="mt-2 flex justify-end"><Button>Send to everyone</Button></div>
  </div>
)

const Verdict = () => (
  <div className="flex shrink-0 items-center gap-4 border-b border-border bg-card px-4 py-2">
    <div className="grid min-w-0 flex-1 gap-1">
      <Text role="subject">The judge picked Gamma — strongest controls and cleanest restart behavior</Text>
      <Text role="meta" className="block truncate">Alpha — playable, collision reset is abrupt</Text>
      <Text role="meta" className="block truncate">Beta — clear board, keyboard input incomplete</Text>
      <Text role="meta" className="block truncate">Gamma — complete</Text>
      <Text role="meta" className="block truncate">Delta — polished, slower start</Text>
    </div>
    <Button>Merge this attempt</Button>
  </div>
)

const RaceRoom = ({ verdict = false, expanded = false }: { verdict?: boolean; expanded?: boolean }) => (
  <div className="relative flex h-[860px] w-[1440px] overflow-hidden bg-background text-foreground">
    <Rail />
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      {verdict && <Verdict />}
      <div className="relative min-h-0 flex-1">
        {expanded ? (
          <Tile member={MEMBERS[1]} expanded />
        ) : (
          <div className="grid h-full min-h-0 grid-cols-2 grid-rows-2 gap-px bg-border">
            <Tile member={MEMBERS[0]} />
            <Tile member={MEMBERS[1]} browser={verdict} />
            <Tile member={MEMBERS[2]} picked={verdict} />
            <Tile member={MEMBERS[3]} browser={verdict} />
            {!verdict && <RoomComposerMock />}
          </div>
        )}
      </div>
    </main>
  </div>
)

export const RaceViewFrames = () => (
  <>
    <Frame title="Race — 4-up, conversations"><div className="border-b border-border px-3 py-2"><Text role="meta">Transcripts are the preview's fixture, not four real attempts.</Text></div><RaceRoom /></Frame>
    <Frame title="Race — 4-up, two tiles on Browser, verdict in"><div className="border-b border-border px-3 py-2"><Text role="meta">Transcripts are the preview's fixture, not four real attempts.</Text></div><RaceRoom verdict /></Frame>
    <Frame title="Race — one tile expanded"><div className="border-b border-border px-3 py-2"><Text role="meta">Transcripts are the preview's fixture, not four real attempts.</Text></div><RaceRoom expanded /></Frame>
  </>
)
