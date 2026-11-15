/** Only invoked after the existing unique, visible, in-viewport hit-test succeeds. */
export async function dispatchPointer(cdp, point, button='left') {
  if (button!=='left' && button!=='right') throw Error('unsupported pointer button')
  const buttons=button==='right'?2:1
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...point})
  await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button,buttons,clickCount:1})
  await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button,buttons:0,clickCount:1})
}
