// Return only counts; never retain an address or process identifier.
export const listenerCounts = output => {
  const addresses=String(output).split('\n').filter(line=>line.startsWith('n')).map(line=>line.slice(1))
  const loopback=addresses.filter(address=>/^127\.0\.0\.1:\d+$/.test(address)||/^\[::1\]:\d+$/.test(address)).length
  return {total:addresses.length,loopback,nonloopback:addresses.length-loopback}
}
