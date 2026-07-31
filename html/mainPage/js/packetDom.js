let tree
let treeElement
let treeContent
let sharedVars

const filteringLogic = require('./filteringLogic.js')

function stringifyData (data, spacing) {
  const seen = new WeakSet()
  try {
    const result = JSON.stringify(data, (key, value) => {
      if (typeof value === 'bigint') return `${value}n`
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
        return Array.from(value)
      }
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]'
        seen.add(value)
      }
      return value
    }, spacing)
    return result === undefined ? String(data) : result
  } catch (err) {
    return String(data)
  }
}

function trimData (data) {
  if (data === undefined || data === null) {
    return 'Could not parse packet'
  }

  let newData
  if (sharedVars.proxyCapabilities.jsonData) {
    const preview = {}
    if (typeof data === 'object') {
      Object.entries(data).forEach(([key, value]) => {
        const serialized = stringifyData(value)
        if (serialized && serialized.length > 15) {
          preview[key] = typeof value === 'number'
            ? Math.round((value + Number.EPSILON) * 100) / 100
            : '...'
        } else {
          preview[key] = value
        }
      })
      newData = stringifyData(preview)
    } else {
      newData = String(data)
    }
  } else {
    newData = data && data.data !== undefined ? String(data.data) : 'Could not parse packet'
  }
  if (newData.length > 750) {
    newData = newData.slice(0, 750)
  }
  return newData
}

function formatTime (ms) {
  const date = new Date(ms)
  if (!Number.isFinite(date.getTime())) return '--:--:--'
  return new Date(date.getTime() - new Date().getTimezoneOffset() * 60000)
    .toISOString().split('T')[1].replace(/[0-9]Z$/, '')
}

function packetHtml (packet, isHidden) {
  const uid = packet.uid
  const meta = packet.meta || {}
  const id = packet.hexIdString === undefined ? '??' : String(packet.hexIdString)
  const name = meta.name === undefined ? 'unknown' : String(meta.name)
  const direction = packet.direction === undefined ? '' : String(packet.direction)
  return `<li id="packet${uid}" onclick="packetClick(${uid})" class="packet ${direction} ${isHidden ? 'filter-hidden' : 'filter-shown'} ${packet.packetValid === false ? 'invalid' : ''}">
        <div class="main-data">
          <span class="id">${escapeHtml(id)}</span>
          <span class="name">${escapeHtml(name)}</span>
          <span class="data">${escapeHtml(trimData(packet.data))}</span>
        </div>
        <span class="time">${escapeHtml(formatTime(packet.time))}</span>
      </li>`
}

exports.addPacketToDOM = function (packet) {
  if (!packet || typeof packet !== 'object') return false
  const isHidden = filteringLogic.packetFilteredByFilterBox(packet, sharedVars.lastFilter, sharedVars.hiddenPackets,
    // TODO: cache these?
    sharedVars.settings.getSetting('inverseFiltering'), sharedVars.settings.getSetting('regexFilter'),
    sharedVars)
  sharedVars.allPacketsHTML.push([packetHtml(packet, isHidden)])
  /* if (!noUpdate) {/html/mainPage/index.html/html/mainPage/index.html
    clusterize.append(sharedVars.allPacketsHTML.slice(-1)[0]);
    if (wasScrolledToBottom) {
      sharedVars.packetList.parentElement.scrollTop = sharedVars.packetList.parentElement.scrollHeight;
    }
  } */
  if (isHidden) {
    sharedVars.hiddenPacketsAmount += 1
  } else {
    sharedVars.packetsUpdated = true
  }
  updateHidden()
  return true
}

exports.addPackets = function (packets, deferRender) {
  if (!Array.isArray(packets)) return 0
  let added = 0
  for (const data of packets) {
    if (!data || typeof data !== 'object') continue
    sharedVars.allPackets.push(data)
    data.uid = sharedVars.allPackets.length - 1

    const isHidden = filteringLogic.packetFilteredByFilterBox(
      data,
      sharedVars.lastFilter,
      sharedVars.hiddenPackets,
      sharedVars.settings.getSetting('inverseFiltering'),
      sharedVars.settings.getSetting('regexFilter'),
      sharedVars
    )

    sharedVars.allPacketsHTML.push([packetHtml(data, isHidden)])
    added++

    if (isHidden) {
      sharedVars.hiddenPacketsAmount += 1
    } else {
      sharedVars.packetsUpdated = true
    }
  }

  if (!deferRender) updateHidden()
  return added
}

function refreshPackets () {
  // TODO: Is this needed?
  /* const wasScrolledToBottom = (sharedVars.packetList.parentElement.scrollTop >= (sharedVars.packetList.parentElement.scrollHeight - sharedVars.packetList.parentElement.offsetHeight))

  sharedVars.allPacketsHTML = []
  sharedVars.allPackets.forEach(function (packet) {
    // noUpdate is true as we want to manually update at the end
    addPacketToDOM(packet, true)
  })
  clusterize.update(sharedVars.allPacketsHTML)
  /if (wasScrolledToBottom) {
    sharedVars.packetList.parentElement.scrollTop = sharedVars.packetList.parentElement.scrollHeight
  } */
}

function updateHidden () {
  document.getElementById("hiddenPackets").innerHTML = sharedVars.hiddenPacketsAmount + ' hidden packets';
  if (sharedVars.hiddenPacketsAmount !== 0) {
     document.getElementById("hiddenPackets").innerHTML += ' (<a href="#" onclick="showAllPackets()">show all</a>)'
  }
}

exports.setup = function (passedSharedVars) {
  sharedVars = passedSharedVars

  treeElement = document.getElementById('tree')
  tree = jsonTree.create({}, treeElement)
  treeContent = treeElement.firstElementChild

  treeContent.innerHTML = 'No packet selected!'

  const actions = document.createElement('div')
  actions.className = 'data-actions'
  actions.innerHTML = '<button id="copy-data-button" type="button" onclick="copyCurrentPacketData()" disabled>Copy data</button>'
  treeElement.appendChild(actions)
}

exports.addPacket = function (data) {
  sharedVars.allPackets.push(data)
  data.uid = sharedVars.allPackets.length - 1
  exports.addPacketToDOM(data)
}

// TODO: use shared var

exports.getTreeElement = function () {
  return treeElement
}

exports.getTree = function () {
  return tree
}

exports.serializeData = stringifyData

exports.refresh = function () {
  updateHidden()
  sharedVars.packetsUpdated = true
}
