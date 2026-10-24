import { useState } from 'react'
import type { RuntimeId, SkillInfo } from '@harnessdesk/protocol'
import { Button, CodeText, IconTile, Monogram, PageExplanation, PreservedText, Row, RowButton, Rows, RowValue, SectionHead, Switch, Text, Toolbar } from '../design'
import { handOverToComposer } from '../lib/compose'
import { DestinationBar } from '../panels/destination-page'
import { useRuntime, useStore } from '../state/context'
import { SparkIcon } from './Icons'

/** A wire name as a sentence: `add-admin-task` → "Add Admin Task". */
const skillTitle = (skill: SkillInfo): string => {
  if (skill.displayName) return skill.displayName
  // Only an all-lowercase wire name is rewritten; a name someone cased on
  // purpose ("MixedCase", "v2 checks") is theirs to keep.
  if (!/^[a-z0-9]+([-_][a-z0-9]+)*$/.test(skill.name)) return skill.name
  return skill.name
    .split(/[-_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/** The scope words runtimes use, as people words. Anything else shows as-is. */
const SKILL_SCOPE_LABEL: Readonly<Record<string, string>> = {
  user: 'Personal',
  repo: 'Project',
  system: 'Built in',
  admin: 'Managed',
}

const skillScopeLabel = (scope: string | undefined): string | null => {
  if (!scope) return null
  // Old snapshots carried the scanned folder here; a path is not a scope.
  if (scope.includes('/')) return null
  return SKILL_SCOPE_LABEL[scope] ?? scope
}

/**
 * The skill's own icon, its accent-coloured initial, or the generic spark.
 *
 * `iconUrl` is a `data:` URI inlined from the installed skill; the adapter
 * drops remote ones, so nothing here reaches the network.
 */
const SkillMark = ({ skill, tile, glyphSize }: { skill: SkillInfo; tile: 'default' | 'sm'; glyphSize: number }) => {
  const [broken, setBroken] = useState(false)
  // Logos use the caller's tile step; the row supplies the fallback's ground.
  if (skill.iconUrl && !broken) {
    return (
      <IconTile size={tile}>
        <img src={skill.iconUrl} alt="" onError={() => setBroken(true)} />
      </IconTile>
    )
  }
  if (skill.brandColor) {
    return (
      <IconTile size={tile} color={skill.brandColor}>
        <Monogram>{skillTitle(skill).charAt(0).toUpperCase()}</Monogram>
      </IconTile>
    )
  }
  return <SparkIcon size={glyphSize} />
}

const SkillToggle = ({ skill, runtime }: { skill: SkillInfo; runtime: RuntimeId }) => {
  const store = useStore()
  return skill.toggleable === false ? (
    // Nothing to switch: the agent declares what it offers and keeps the
    // on/off to itself, so the row is a list entry.
    <RowValue>Always on</RowValue>
  ) : (
    <span onClick={(event) => event.stopPropagation()}>
      <Switch
        aria-label={skill.name}
        checked={skill.enabled}
        onCheckedChange={(next) =>
          void store.setSkillEnabled({ name: skill.name, path: skill.path }, next, runtime)
        }
      />
    </span>
  )
}

/** One skill, in full, with its availability beside the heading. */
export const RuntimeSkillPage = ({
  skill,
  listLabel,
  onBack,
  onUse,
}: {
  skill: SkillInfo
  listLabel: string
  onBack: () => void
  onUse: () => void
}) => {
  const runtime = useRuntime()
  const scope = skillScopeLabel(skill.scope)
  return (
    <>
      <DestinationBar place={skillTitle(skill)} />
      <Toolbar><Button variant="ghost" size="sm" onClick={onBack}>Back to {listLabel}</Button><SkillMark skill={skill} tile="sm" glyphSize={16}/></Toolbar>
      <PageExplanation>{`${runtime.presentation.name}${scope?` · ${scope}`:''}`}</PageExplanation>
      {skill.shortDescription && <PageExplanation>{skill.shortDescription}</PageExplanation>}
      <Rows><Row title={skillTitle(skill)} control={<><SkillToggle skill={skill} runtime={runtime.id}/><Button variant="outline" size="sm" onClick={() => { onUse(); void handOverToComposer({text:`@${skill.name} `}) }}>Use in composer</Button></>}/></Rows>

      {skill.description && skill.description !== skill.shortDescription && (
        <>
          <SectionHead level="label" name="What it does" />
          <PreservedText value={skill.description}/>
        </>
      )}

      <SectionHead level="label" name="About" />
      <Rows>
        <Row title="Identifier" control={<Text role="meta"><CodeText>{skill.name}</CodeText></Text>} />
        {skill.path && (
          <Row
            title="Where it lives"
            control={<RowValue>{skill.path}</RowValue>}
          />
        )}
      </Rows>

    </>
  )
}

/** Commands reported by the active runtime that have no scanned Library entry. */
export const RuntimeSkillRows = ({ skills, runtime, onOpen }: {
  readonly skills: readonly SkillInfo[]; readonly runtime: RuntimeId; readonly onOpen: (name: string) => void
}) => <Rows role="group" aria-label="Runtime commands">{skills.map(skill => <RowButton key={skill.name} kind="record" title={skillTitle(skill)}
  desc={<Text role="muted" lines={2}>{skill.shortDescription ?? skill.description}</Text>}
  mark={skill.iconUrl || skill.brandColor ? <SkillMark skill={skill} tile="sm" glyphSize={16} /> : undefined}
  action={skill.toggleable === false ? undefined : <SkillToggle skill={skill} runtime={runtime} />}
  control={skill.toggleable === false ? <Text role="meta">Always on</Text> : undefined}
  onClick={() => onOpen(skill.name)} />)}</Rows>
