import { Search, RowButton, Rows, Section, ChangeStats } from '../design'
export interface ReviewIndexGroup {
  readonly folder: string
  readonly files: readonly { readonly path: string; readonly name: string; readonly added: number; readonly removed: number }[]
}
/** A search field alone leads the review page's first row. */
export const ReviewFilter = ({ query, change }: {
  readonly query: string; readonly change: (query: string) => void
}) => <Search label="Filter files" placeholder="Filter files" value={query} onChange={change} />

/** The review's file index uses the same body rows as other page lists. */
export const ReviewIndex = ({ groups, jump }: {
  readonly groups: readonly ReviewIndexGroup[]; readonly jump: (path: string) => void
}) => <>
  {groups.map(group => <Section key={group.folder || '.'} title={group.folder || 'in this folder'}>
    <Rows>{group.files.map(file => <RowButton key={file.path} title={file.name}
      control={file.added + file.removed > 0 ? <ChangeStats added={file.added} removed={file.removed} /> : undefined}
      onClick={() => jump(file.path)} />)}</Rows>
  </Section>)}
</>
