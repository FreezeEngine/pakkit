const _eval = require('node-eval')

BigInt.prototype.toJSON = function () {
  const value = Number(this)
  return Number.isSafeInteger(value) ? value : this.toString()
}

let mainWindow
let ipcMain
let proxy
let scriptingEnabled = false
let currentScript
let currentScriptModule

function sendToRenderer (channel, payload) {
  if (
    !mainWindow ||
    (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed()) ||
    !mainWindow.webContents ||
    (typeof mainWindow.webContents.isDestroyed === 'function' && mainWindow.webContents.isDestroyed())
  ) {
    return false
  }

  try {
    mainWindow.send(channel, payload)
    return true
  } catch (error) {
    if (!String(error && error.message).toLowerCase().includes('destroyed')) {
      console.error(error)
    }
    return false
  }
}

const server = {
  sendPacket: function (meta, data) {
    proxy.writeToServer(meta, data, true)
  }
}

const client = {
  sendPacket: function (meta, data) {
    proxy.writeToClient(meta, data, true)
  }
}

exports.init = function (window, passedIpcMain, passedProxy) {
  mainWindow = window
  ipcMain = passedIpcMain
  proxy = passedProxy

  if (window && typeof window.once === 'function') {
    window.once('closed', () => {
      if (mainWindow === window) mainWindow = null
    })
  }

  ipcMain.on('injectPacket', (event, arg) => {
    const ipcMessage = JSON.parse(arg)
    if (ipcMessage.direction === 'clientbound') {
      passedProxy.writeToClient(ipcMessage.meta, ipcMessage.data, false)
    } else {
      passedProxy.writeToServer(ipcMessage.meta, ipcMessage.data, false)
    }
  })

  ipcMain.on('scriptStateChange', (event, arg) => {
    const ipcMessage = JSON.parse(arg)
    scriptingEnabled = ipcMessage.scriptingEnabled
    proxy.setScriptingEnabled(scriptingEnabled)
    currentScript = ipcMessage.script
    // prevent that the script gets executed when scripting is disabled
    if(scriptingEnabled) {
      currentScriptModule = _eval(currentScript, '/script.js')
    } else {
      currentScriptModule = _eval('', '/script.js')
    }
  })
}

exports.packetHandler = function (direction, meta, data, id, canUseScripting, packetValid, raw) {
  try {
    // TODO: Maybe write raw data?
    if (proxy.capabilities.scriptingSupport && canUseScripting && scriptingEnabled) {
      if (direction === 'clientbound') {
        currentScriptModule.downstreamHandler(meta, data, server, client)
      } else {
        currentScriptModule.upstreamHandler(meta, data, server, client)
      }
    }
    const packetRaw = raw || proxy.getRaw(direction, meta.name, data)
    sendToRenderer('packet', JSON.stringify({ meta: meta, data: data, direction: direction, hexIdString: id, raw: packetRaw, time: Date.now(), packetValid: packetValid }))
  } catch (err) {
    if (!String(err && err.message).toLowerCase().includes('destroyed')) {
      console.error(err)
    }
  }
}

exports.messageHandler = function (header, info, fatal) {
  sendToRenderer('message', JSON.stringify({ header: header, info: info, fatal: fatal }))
}
