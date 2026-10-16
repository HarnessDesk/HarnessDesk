import { useState } from 'react'
import { CompactBoardCard, Dot, Text } from '..'

/** The shared card without Team-specific path, faces or project facts. */
export const BoardCardExample = () => {
 const [opened,setOpened]=useState(0)
 return <div className="flex flex-col gap-4">
  <section data-catalog-state="warning">
   <CompactBoardCard label="Open checkout" title="Checkout" titleAside={<Dot tone="info" aria-label="Unread changes"/>}
    detail="Choose a deployment target." attention detailProps={{id:'board-card-detail'}} aria-describedby="board-card-detail board-card-facts"
    middle={<Text role="meta">Review</Text>} footer={<Text id="board-card-facts" role="meta">storefront · 2h</Text>}
    onOpen={()=>setOpened(count=>count+1)}/>
  </section>
  <section data-catalog-state="default">
   <CompactBoardCard label="Open invoice" title="Invoice" onOpen={()=>setOpened(count=>count+1)}/>
  </section>
  <Text role="meta"><span role="status">Opened {opened} {opened===1?'time':'times'}</span></Text>
 </div>
}
