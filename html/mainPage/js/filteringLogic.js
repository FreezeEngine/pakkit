exports.packetFilteredByFilterBox = function (packet, filter, hiddenPackets, inverseFiltering, regexFilter,
  sharedVars) {
  if (!packet || !hiddenPackets) return false
  const direction = packet.direction || ''
  const meta = packet.meta || {}
  const packetName = meta.name === undefined ? 'unknown' : String(meta.name)
  const hiddenForDirection = Array.isArray(hiddenPackets[direction])
    ? hiddenPackets[direction]
    : []
  if (hiddenForDirection.includes(packetName)) {
    return true
  }

  if (sharedVars.lastFilter === '') {
    return false
  }

  let packetData
  try {
    packetData = JSON.stringify(packet.data)
  } catch (err) {
    packetData = String(packet.data)
  }
  const comparisonString = String(packet.hexIdString || '') + ' ' + packetName + ' ' + packetData

  if (regexFilter && typeof filter === 'string') {
    try {
      filter = new RegExp(sharedVars.lastFilter)
    } catch (err) {
      // TODO: handle
      console.error(err)
      filter = new RegExp("")
    }
  }

  let result
  if (regexFilter) {
    result = filter.test(comparisonString)
  } else {
    result = comparisonString.includes(filter)
  }

  if (inverseFiltering) {
    return result
  } else {
    return !result
  }
}

exports.packetCollapsed = function (packet, filter, hiddenPackets) {
  return Boolean(packet && packet.meta && packet.meta.name === 'position')
}
