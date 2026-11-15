import { createHash } from 'node:crypto'
export function inspectFrame(bytes, privacyReasons) {
  if (!Array.isArray(privacyReasons) || privacyReasons.length) throw new Error('privacy audit failed')
  if (!Buffer.isBuffer(bytes) || bytes.length<45 || bytes.length>2_000_000 || bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a' || bytes.readUInt32BE(8)!==13 || bytes.toString('ascii',12,16)!=='IHDR' || bytes.subarray(-12).toString('hex')!=='0000000049454e44ae426082') throw new Error('invalid frame')
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20)
  if(width<300||height<300||width>4096||height>4096)throw new Error('invalid frame dimensions')
  return {bytes,width,height,sha256:createHash('sha256').update(bytes).digest('hex')}
}
