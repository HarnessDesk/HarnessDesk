import { useState } from 'react'

import { BrandMark } from '@/components/BrandIcons'
import {
  ArchiveIcon,
  BranchIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  SessionIcon,
  SettingsIcon,
  TeamIcon,
  UsageIcon,
} from '@/components/Icons'
import {
  Button,
  IconTile,
  InputGroupAddon,
  InputGroupInput,
  InputGroup,
  Rail,
  RailBody,
  RailFooter,
  RailHeader,
  RailItem,
  RailLabel,
} from '../ui'
import styles from './rail-board.module.css'

/**
 * The left bar, at the density it actually stands at.
 *
 * Shown inside a frame the width of a real window rather than on the page,
 * because a rail is only judgeable next to the thing it is beside: the whole
 * question is how much attention it takes from the work, and a rail floating
 * alone on a white page always looks fine.
 *
 * What the arrangement below is arguing:
 *
 *   The workspace is pinned.       Top and bottom do not scroll. The two things
 *                                  reached for without looking — where am I,
 *                                  and who am I — must not move when the middle
 *                                  grows to forty sessions.
 *
 *   Group projects are a kind      Same rows, same density, a different mark
 *   of session, not a section.     and a member count. Giving them their own
 *                                  region would say they are a different part
 *                                  of the app, and then a reader has to know
 *                                  which kind a thing is before they can find
 *                                  it.
 *
 *   State lives on the row.        A running session carries a live dot, a
 *                                  waiting one a count. Not a separate
 *                                  "Running" group — a session that changes
 *                                  state would then jump between groups while
 *                                  being read, which is the worst thing a
 *                                  navigation list can do.
 *
 *   Depth, not guides.             Worktrees indent under their repository.
 *                                  Tree guides at this size are four more
 *                                  vertical lines competing with the divider,
 *                                  the scrollbar and the pane edge.
 */

const SESSIONS = [
  { id: 's1', title: 'Migrate the auth callers', brand: 'claudecode' as const, live: true },
  { id: 's2', title: 'Integration tests for the gateway', brand: 'codex' as const, live: true },
  { id: 's3', title: 'Trace the flaky socket test', brand: 'deepseek' as const, waiting: 1 },
  { id: 's4', title: 'Rewrite the release notes', brand: 'cursor' as const },
]

export const RailBoard = () => {
  const [selected, setSelected] = useState('g1')

  return (
    <div className={styles.railCase}>
      <Rail>
        <RailHeader>
          <IconTile tint="blue" size="sm">
            <FolderIcon />
          </IconTile>
          <span className="min-w-0 flex-1 truncate text-base font-medium">harnessdesk</span>
          <Button variant="ghost" size="icon-sm" aria-label="New session">
            <PlusIcon />
          </Button>
        </RailHeader>

        <div className="px-2 pb-1">
          <InputGroup>
            <InputGroupAddon align="inline-start">
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput placeholder="Search" aria-label="Search sessions" />
          </InputGroup>
        </div>

        <RailBody>
          <RailItem icon={<UsageIcon />}>Usage</RailItem>
          <RailItem icon={<ArchiveIcon />} trail="34">
            Archive
          </RailItem>

          <RailLabel>Group projects</RailLabel>
          <RailItem
            icon={<TeamIcon />}
            selected={selected === 'g1'}
            onClick={() => setSelected('g1')}
            trail="4"
          >
            Auth migration
          </RailItem>
          <RailItem icon={<TeamIcon />} onClick={() => setSelected('g2')} selected={selected === 'g2'} trail="2">
            Release 0.5
          </RailItem>

          <RailLabel
            action={
              <Button variant="ghost" size="icon-sm" aria-label="New session">
                <PlusIcon />
              </Button>
            }
          >
            Sessions
          </RailLabel>
          {SESSIONS.map((session) => (
            <RailItem
              key={session.id}
              icon={<BrandMark brand={session.brand} size={16} />}
              selected={selected === session.id}
              onClick={() => setSelected(session.id)}
              trail={
                session.live ? (
                  <span
                    aria-label="Running"
                    className="inline-block size-1.5 animate-pulse rounded-full bg-(--hd-success)"
                  />
                ) : session.waiting ? (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-(--hd-primary) px-1 text-xs text-(--hd-primary-foreground)">
                    {session.waiting}
                  </span>
                ) : undefined
              }
            >
              {session.title}
            </RailItem>
          ))}

          <RailLabel>Worktrees</RailLabel>
          <RailItem icon={<BranchIcon />} onClick={() => setSelected('w1')} selected={selected === 'w1'}>
            main
          </RailItem>
          <RailItem icon={<SessionIcon />} depth={1}>
            Split the transport package
          </RailItem>
          <RailItem icon={<BranchIcon />}>feat/editor-plane</RailItem>
          <RailItem icon={<SessionIcon />} depth={1}>
            Block nine
          </RailItem>
        </RailBody>

        <RailFooter>
          <IconTile tint="violet" size="sm" shape="round">
            <BrandMark brand="anthropic" size={13} />
          </IconTile>
          <span className="min-w-0 flex-1 truncate text-sm">iamenahs</span>
          <Button variant="ghost" size="icon-sm" aria-label="Settings">
            <SettingsIcon />
          </Button>
        </RailFooter>
      </Rail>

      <div className={styles.railBeside}>
        The pane the rail is beside. It is here because a rail can only be judged
        next to the work it is taking attention from.
      </div>
    </div>
  )
}
