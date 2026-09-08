/**
 * `Page.printToPDF`, answered by Electron.
 *
 * Headed Chromium does not implement the DevTools method — through the
 * pane's debugger it answers "'Page.printToPDF' wasn't found" — but a
 * `webContents` prints the same page itself. The browser tools speak the
 * protocol and nothing else, so the shell answers the method in the
 * protocol's own shape: CDP's inches become Electron's inches, and the
 * bytes come back as `{ data }` in base64, which is what the service reads.
 *
 * Pure, so the mapping is tested where Electron is not.
 */

/** CDP's paper and margin fields → `webContents.printToPDF` options. */
export const printOptions = (params = {}) => {
  const options = {
    printBackground: params.printBackground !== false,
    landscape: params.landscape === true,
  }
  if (typeof params.scale === 'number') options.scale = params.scale
  if (typeof params.pageRanges === 'string' && params.pageRanges) options.pageRanges = params.pageRanges
  if (params.displayHeaderFooter === true) {
    options.displayHeaderFooter = true
    if (typeof params.headerTemplate === 'string') options.headerTemplate = params.headerTemplate
    if (typeof params.footerTemplate === 'string') options.footerTemplate = params.footerTemplate
  }
  if (params.preferCSSPageSize === true) options.preferCSSPageSize = true
  if (typeof params.paperWidth === 'number' && typeof params.paperHeight === 'number') {
    options.pageSize = { width: params.paperWidth, height: params.paperHeight }
  }
  const margins = {}
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const value = params[`margin${side[0].toUpperCase()}${side.slice(1)}`]
    if (typeof value === 'number') margins[side] = value
  }
  if (Object.keys(margins).length > 0) options.margins = margins
  return options
}

/** The protocol's answer, from Electron's bytes. */
export const printResult = (pdf) => ({ data: Buffer.from(pdf).toString('base64') })
