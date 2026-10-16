const scriptExtensions = new Set('sh bash zsh fish py rb pl php js mjs cjs ts lua ps1 bat cmd command jar'.split(' '))
const programHeaders = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe], [0x4d, 0x5a],
]

/** Describe the files in the same order the bundle reader supplies them. */
export function classifySkillFiles(files: readonly { readonly path: string; readonly bytes: Uint8Array; readonly mode?: number }[]): {
  path: string; bytes: number; runnable: boolean; binary: boolean; reason: string | null
}[] {
  return files.map(({ path, bytes, mode }) => {
    const extension = /\.([^.\/\\]+)$/.exec(path)?.[1]?.toLowerCase()
    const firstSegment = path.split(/[/\\]/)[0]
    const reason = ((mode ?? 0) & 0o111) !== 0 ? 'executable file'
      : bytes[0] === 0x23 && bytes[1] === 0x21 ? 'starts with #!'
      : programHeaders.some(header => header.every((byte, index) => bytes[index] === byte)) ? 'executable program'
      : extension && scriptExtensions.has(extension) ? `script (.${extension})`
      : firstSegment === 'bin' || firstSegment === 'hooks' || firstSegment === 'scripts' ? 'in scripts/'
      : null
    const sample = bytes.subarray(0, 8192)
    let binary = sample.includes(0)
    if (!binary) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(sample) }
      catch { binary = true }
    }
    return { path, bytes: bytes.length, runnable: reason !== null, binary, reason }
  })
}
