import { expect, it } from 'vitest'
import { overviewInput, overviewRun } from '../preview/team-overview-fixture'
import { PREVIEW_GOAL } from '../preview/goal-fixture'
import { teamOverview } from './team-overview'
import { teamListRow, type TeamListInput } from './teams-list'
import { teamBoardColumn, teamBoardItem } from './teams-board'

const input = (scene: Parameters<typeof overviewInput>[0] = 'idle'): TeamListInput => {
 const source = overviewInput(scene)
 const facts = {...source,seats:source.seats.map(seat=>scene==='running'?{...seat,approvals:[]}:seat)}
 const execution = overviewRun(scene === 'done' ? 'settled' : scene === 'stalled' ? 'stalled' : 'running')
 return { team: {...PREVIEW_GOAL.board, intents:facts.cards}, goal:null, execution,
  overview:teamOverview({...facts, run:{execution,startedAt:100}}) }
}

it('places every Team state in exactly one column', () => {
 const idle = input()
 const done = input('done')
 const failed = {...input(),goal:{...PREVIEW_GOAL,activity:'needs-you' as const}}
 failed.overview.needsYou = [{kind:'card',seat:null,card:1,summary:'The current check failed.',since:100}]
 const cases: [TeamListInput, string][] = [
  [input('needs-you'), 'needs-you'], [input('running'), 'working'], [idle, 'working'],
  [done, 'ready'],
  [{...done, goal:{...PREVIEW_GOAL,goal:{...PREVIEW_GOAL.goal,state:'wrapped'}}}, 'ready'],
  [{...idle, execution:{...idle.execution!,state:'stopped'}, stopping:true}, 'working'],
  [{...idle, execution:{...idle.execution!,state:'stopped'}}, 'needs-you'],
  [failed, 'needs-you'], [input('stalled'), 'needs-you'],
 ]
 for (const [one, column] of cases) expect(teamBoardColumn(teamListRow(one))).toBe(column)
})

it('keeps a stopped Run in Needs you when its unread messages mask the stopped row state', () => {
 const one=input('unread')
 expect(teamBoardItem({...one,execution:{...one.execution!,state:'stopped'}}).column).toBe('needs-you')
})

it('keeps follow-up work Working after its Run settles and never hides ready work', () => {
 const done = input('done')
 const followup = {...done, team:{...done.team,intents:[{...done.team.intents[0]!,state:'open' as const}]}}
 expect(teamBoardColumn(teamListRow(followup))).toBe('working')
 const row = teamListRow(done)
 expect(teamBoardColumn(teamListRow(done,{hidden:{[row.id]:row.change},seen:{}}))).toBe('ready')
})

it('uses the first sentence as title, retains the whole brief and uses Team age', () => {
 const one = input()
 const item = teamBoardItem({...one,team:{...one.team,name:'Fix checkout. Keep the retry bounded.'},goal:{...PREVIEW_GOAL,goal:{...PREVIEW_GOAL.goal,sentence:'Fix checkout. Keep the retry bounded.',createdAt:42}}})
 expect(item.title).toBe('Fix checkout.')
 expect(item.row.sentence).toBe('Fix checkout. Keep the retry bounded.')
 expect(item.createdAt).toBe(42)
})

it('draws the frozen Flow with completed, current and unreached steps, and none without a Run', () => {
 const source = input('running')
 const one = {...source,team:{...source.team,intents:source.team.intents.map(card=>card.id===1?{...card,state:'done' as const,claim:null}:card)}}
 const item = teamBoardItem(one)
 expect(item.path.length).toBe(one.execution!.document.flow.roles.length)
 expect(item.path.some(step=>step.state==='done')).toBe(true)
 expect(item.path.some(step=>step.state==='current')).toBe(true)
 expect(item.path.some(step=>step.state==='future')).toBe(true)
 expect(teamBoardItem({...one,execution:null}).path).toEqual([])
})

it('shows the current step, round and observed activity instead of a seat count', () => {
 const one = input('running')
 one.overview.seats[0] = {...one.overview.seats[0]!,state:'working',doing:'Running tests'}
 expect(teamBoardItem(one).summary).toContain('round 2')
 expect(teamBoardItem(one).summary).toContain('Running tests')
 expect(teamBoardItem(input('done')).summary).toBe('Run complete')
})

it('does not invent a completed Run for a ready Team with no Flow', () => {
 const one=input()
 const manual={...one,execution:null,goal:{...PREVIEW_GOAL,activity:'ready-to-wrap' as const},overview:{...one.overview,run:null}}
 expect(teamBoardItem(manual)).toMatchObject({summary:'Work complete',path:[]})
})
