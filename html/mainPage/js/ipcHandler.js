let sharedVars

exports.setup = function (passedSharedVars) {
  sharedVars = passedSharedVars

  sharedVars.ipcRenderer.on('copyPacketData', (event, arg) => {
    const ipcMessage = JSON.parse(arg)
    const packet = sharedVars.allPackets[Number(ipcMessage.id)]
    if (!packet) return
    const data = sharedVars.proxyCapabilities.jsonData
      ? sharedVars.packetDom.serializeData(packet.data, 2)
      : packet.data && packet.data.data !== undefined
        ? String(packet.data.data)
        : ''
    sharedVars.ipcRenderer.send('copyToClipboard', data)
  })

  sharedVars.ipcRenderer.on('copyHexData', (event, arg) => {
    const ipcMessage = JSON.parse(arg)
    let data = ''
    const packet = sharedVars.allPackets[Number(ipcMessage.id)]
    if (!packet || !packet.raw) return
    for (const byte of packet.raw) {
      data += byte.toString(16).padStart(2, '0')
      data += ' '
    }
    data = data.trim().toUpperCase()
    sharedVars.ipcRenderer.send('copyToClipboard', data)
  })

  sharedVars.ipcRenderer.on('copyTeleportCommand', (event, arg) => {
    console.log(sharedVars.allPackets)
    const ipcMessage = JSON.parse(arg)
    const packet = sharedVars.allPackets[Number(ipcMessage.id)]
    if (!packet || !packet.data) return
    const data = packet.data

    let clipData = '/tp @p ' + ((data.flags & 0x01) ? '~' : '') + ((data.x === 0 && (data.flags & 0x01)) ? '' : data.x) +
      ((data.flags & 0x02) ? ' ~' : ' ') + ((data.y === 0 && (data.flags & 0x03)) ? '' : data.y) +
      ((data.flags & 0x04) ? ' ~' : ' ') + ((data.z === 0 && (data.flags & 0x04)) ? '' : data.z)

    if (!(data.flags & 0x10) || !(data.flags & 0x08) || data.pitch != 0 || data.yaw !== 0) {
      clipData += ((data.flags & 0x10) ? ' ~' : ' ') + data.pitch +
        ((data.flags & 0x08) ? ' ~' : ' ') + data.yaw
    }

    sharedVars.ipcRenderer.send('copyToClipboard', clipData)
  })

  sharedVars.ipcRenderer.on('packet', (event, arg) => {
    const ipcMessage = JSON.parse(arg)
    sharedVars.packetDom.addPacket(ipcMessage)
  })

  sharedVars.ipcRenderer.on('error', (event, arg) => {
    const ipcMessage = JSON.parse(arg)
    handleError(ipcMessage.msg, ipcMessage.stack)
  })

  sharedVars.ipcRenderer.on('message', (event, arg) => {
    const ipcMessage = JSON.parse(arg)
    errorDialog(ipcMessage.header, ipcMessage.info, ipcMessage.fatal)
  })

  sharedVars.ipcRenderer.on('updateFiltering', (event, arg) => {
    console.log('update!!!')
    sharedVars.proxyCapabilities = JSON.parse(sharedVars.ipcRenderer.sendSync('proxyCapabilities', ''))
    window.updateFilteringPackets()
  })

  sharedVars.ipcRenderer.on('loadLogStart', (event, request) => {
    const { requestId, payload } = request

    try {
      window.activeLoadId = payload.loadId
      window.loadLogRunning = true

      if (typeof window.deselectPacket === 'function') {
        window.deselectPacket()
      }

      sharedVars.allPackets = []
      sharedVars.allPacketsHTML = []
      sharedVars.hiddenPacketsAmount = 0
      sharedVars.packetsUpdated = false
      if (sharedVars.packetList) {
        sharedVars.packetList.innerHTML = ''
      }

      console.log(
        `Loading log: ${payload.filePath} (${payload.fileSize} bytes)`
      )

      sharedVars.ipcRenderer.send(
        `loadLogStart-ack-${requestId}`,
        {
          success: true
        }
      )
    } catch (err) {
      sharedVars.ipcRenderer.send(
        `loadLogStart-ack-${requestId}`,
        {
          error: err.message
        }
      )
    }
  })

  sharedVars.ipcRenderer.on('loadLogChunk', (event, request) => {
    const { requestId, payload } = request

    try {
      if (payload.loadId !== window.activeLoadId) {
        throw new Error('Invalid load session')
      }

      sharedVars.packetDom.addPackets(payload.packets, true)

      sharedVars.ipcRenderer.send(
        `loadLogChunk-ack-${requestId}`,
        {
          success: true,
          packetCount: sharedVars.allPackets.length
        }
      )
    } catch (err) {
      sharedVars.ipcRenderer.send(
        `loadLogChunk-ack-${requestId}`,
        {
          error: err.message
        }
      )
    }
  })

  sharedVars.ipcRenderer.on('loadLogFinish', (event, request) => {
    const { requestId, payload } = request

    try {
      if (payload.loadId !== window.activeLoadId) {
        throw new Error('Invalid load session')
      }

      sharedVars.packetDom.refresh()

      console.log(
        `Loaded ${payload.packetCount} packets`
      )

      window.activeLoadId = null
      window.loadLogRunning = false

      sharedVars.ipcRenderer.send(
        `loadLogFinish-ack-${requestId}`,
        {
          success: true
        }
      )
    } catch (err) {
      sharedVars.ipcRenderer.send(
        `loadLogFinish-ack-${requestId}`,
        {
          error: err.message
        }
      )
    }
  })

  sharedVars.ipcRenderer.on('loadLogError', (event, payload) => {
    if (
      payload.loadId &&
      window.activeLoadId &&
      payload.loadId !== window.activeLoadId
    ) {
      return
    }

    window.activeLoadId = null
    window.loadLogRunning = false

    console.error(
      'Log load failed:',
      payload.error
    )

    alert(
      `Log load failed: ${payload.error}`
    )
  })

  sharedVars.ipcRenderer.on('loadScriptData', (event, arg) => {
    window.scriptEditor.getDoc().setValue(arg)
    sharedVars.ipcRenderer.send('scriptStateChange', JSON.stringify({ //
      scriptingEnabled: document.getElementById('enableScripting').checked,
      script: arg
    }))
  })

  sharedVars.ipcRenderer.on('enableBtnScriptSave', (event, arg) => {
    document.getElementById('btnScriptSave').disabled = false
    document.getElementById('btnScriptSave').title = arg
  })

  sharedVars.ipcRenderer.on('disableBtnScriptSave', (event, arg) => {
    document.getElementById('btnScriptSave').disabled = true
    document.getElementById('btnScriptSave').title = ''
  })

}
