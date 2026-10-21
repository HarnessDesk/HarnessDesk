import { useId, type ReactNode } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Dot, Text } from './Settings'
import { BoardCard } from './BoardCard'
import { SegmentMeter } from '../ui/chart'
import { IssueMark, Menu, MenuItem } from './Menu'
import { Popover } from './Popover'
import { PageOptions } from './PageOptions'
import { CaretIcon, PlusIcon } from '../../components/Icons'
import styles from './TeamsBoard.module.css'

/** The Teams page's body controls: creation, project scope and search. */
export const TeamsBoardToolbar = ({create,disabled,project,projects,changeProject,search,changeSearch}: {
 readonly create:()=>void; readonly disabled:boolean; readonly project:string
 readonly projects:readonly {readonly id:string;readonly label:string}[]; readonly changeProject:(id:string)=>void
 readonly search:string; readonly changeSearch:(value:string)=>void
}) => <div data-slot="teams-board-toolbar" className={styles.toolbar}>
 <PageOptions title="Teams" action={{label:'New Team',icon:<PlusIcon/>,disabled:disabled?'Open a project folder first.':false,run:create}}/>
 <Text as="p" role="muted" ink="secondary" className={styles.purpose}>Follow the work, answer what needs you, and wrap what’s done.</Text>
 <div className={styles.filters}>
 <Popover title="Filter Teams by project" label={<>{projects.find(one=>one.id===project)?.label ?? 'All projects'}<CaretIcon/></>} icons="none" triggerVariant={{variant:'ghost',size:'sm'}}>
  {close=><Menu close={close}>{[{id:'',label:'All projects'},...projects].map(one=><MenuItem key={one.id} label={one.label} selected={one.id===project} onSelect={()=>{changeProject(one.id);close()}}/>)}</Menu>}
 </Popover>
 <Input className={styles.search} type="search" aria-label="Search Teams" placeholder="Search Teams" value={search} onChange={event=>changeSearch(event.target.value)}/>
 </div>
</div>

/** Fixed attention columns retain their order and stack together in a narrow pane. */
export const TeamsBoard = ({children}: {readonly children:ReactNode}) => <div data-slot="teams-board" className={styles.board}>{children}</div>

/** A column says the state once, beside its tone and count. */
export const TeamsBoardColumn = ({label,tone,count,children}: {
 readonly label:string; readonly tone:'warning'|'brand'|'success'; readonly count:number; readonly children:ReactNode
}) => <section data-slot="teams-board-column" aria-label={label} className={styles.column}>
 <Text as="h2" role="section" className={styles.heading}><Dot tone={tone}/><span>{label}</span><Text role="meta" numeric>{count}</Text></Text>
 <div className={styles.cards}>{children}</div>
</section>

/** One Team's work, observed Run path and faces, with a single keyboard opening. */
export const TeamsBoardCard = ({id,title,brief,summary,issue,attention=false,unread=false,path,faces,project,age,open}: {
 readonly id:string; readonly title:string; readonly brief:string; readonly summary:string; readonly issue?:string; readonly attention?:boolean; readonly unread?:boolean
 readonly path:readonly {readonly id:string;readonly label:string;readonly state:'done'|'current'|'future'}[]
 readonly faces?:ReactNode; readonly project:string; readonly age:ReactNode; readonly open:()=>void
}) => {
 const description=useId(),facts=useId()
 return <BoardCard data-team-row={id} label={`Open ${title}`} title={<span className={styles.title}>{title}</span>} onOpen={open} aria-describedby={`${description} ${facts}`}
  titleProps={{'data-slot':'team-title',title:brief}} titleAside={unread && <Dot tone="info" aria-label="Unread changes"/>}
  detail={issue?<span className={styles.status}><Text role="muted" tone={attention?'warning':undefined}>{summary}</Text><IssueMark message={issue}/></span>:summary}
  detailProps={{id:description,'data-slot':'team-detail',title:issue??summary}} detailLines={issue?undefined:2} attention={attention&&!issue}
  middle={path.length>0 && <SegmentMeter className={styles.path} steps={path.map(step=>({...step,key:step.id}))}
   label={path.map(step=>`${step.label}: ${step.state==='future'?'not reached':step.state}`).join(', ')}/>}
  footer={<>{faces}<Text id={facts} role="meta" className={styles.facts}><span className={styles.project} title={project}>{project}</span><span>·</span><span data-slot="team-age">{age}</span></Text></>}/>
}

/** Wrapped receipts cost no card height until their group is opened. */
export const TeamsBoardWrapped = ({count,open,toggle,children}: {readonly count:number;readonly open:boolean;readonly toggle:()=>void;readonly children:ReactNode}) => {
 const id=useId()
 return <><Button variant="ghost" size="sm" className={styles.wrapped} aria-expanded={open} aria-controls={id} onClick={toggle}><Text role="meta">Wrapped · {count}</Text><CaretIcon data-open={open||undefined}/></Button>
  <div id={id} hidden={!open} className={styles.cards}>{open?children:null}</div></>
}
