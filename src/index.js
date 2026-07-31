require('./fetch-polyfill')

const { program } = require('commander')

program
  .option('-a, --autostart', 'Automatically starts the program without the start window (all below options must be set)')
  .option('-e, --platform <platform>', 'Platform (accepted values: java, bedrock)')
  .option('-v, --version <version>', 'The version to use (not needed for Bedrock)')
  .option('-c, --connect <address>', 'The address of the server to connect to')
  .option('-p, --connect-port <port>', 'The port of the server to connect to')
  .option('-P, --listen-port <port>', 'The port to listen on')

program.parse(process.argv)

const options = program.opts()

if (options.autostart) {
  if (
    !options.platform ||
    !(options.version || options.platform !== 'java') ||
    !options.connect ||
    !options.connectPort ||
    !options.listenPort
  ) {
    console.log('Not all required options were passed.')
    program.help()
  }
}

const {
  app,
  BrowserWindow,
  ipcMain,
  clipboard,
  Menu,
  dialog,
  shell
} = require('electron')

app.allowRendererProcessReuse = true

const fs = require('fs')
const Store = require('electron-store')

const store = new Store()

let proxy

const resourcesPath = fs.existsSync(
  process.resourcesPath.concat('/app/')
)
  ? process.resourcesPath.concat('/app/')
  : './'

const javaProxy = require('./proxy/java/proxy.js')
const bedrockProxy = require('./proxy/bedrock/proxy.js')

const packetHandler = require('./packetHandler.js')

const electronLocalShortcut = require('electron-localshortcut')
const windowStateKeeper = require('electron-window-state')
const unhandled = require('electron-unhandled')

const osDataFolder = app.getPath('appData')
const dataFolder = osDataFolder + '/pakkit'

let currentScriptFile = null

let activeLogSave = null

function sendToWindow (win, channel, ...args) {
  if (
    !win ||
    (typeof win.isDestroyed === 'function' && win.isDestroyed()) ||
    !win.webContents ||
    (typeof win.webContents.isDestroyed === 'function' && win.webContents.isDestroyed())
  ) {
    return false
  }

  try {
    win.webContents.send(channel, ...args)
    return true
  } catch (error) {
    if (!String(error && error.message).toLowerCase().includes('destroyed')) {
      console.error(error)
    }
    return false
  }
}

function makeMenu (direction, text, id, invalid, noData) {
  if (
    direction !== 'clientbound' &&
    direction !== 'serverbound'
  ) {
    return
  }

  const menuData = [
    {
      icon:
        resourcesPath +
        `icons/${direction + (invalid ? '-invalid' : '')}.png`,
      label: text,
      enabled: false
    },
    {
      type: 'separator'
    },
    {
      label: 'Edit and resend',
      click: () => {
        sendToWindow(BrowserWindow.getAllWindows()[0],
          'editAndResend',
          JSON.stringify({
            id
          })
        )
      },
      visible: proxy.capabilities.modifyPackets
    },
    {
      label: 'Hide all packets of this type',
      click: () => {
        sendToWindow(BrowserWindow.getAllWindows()[0],
          'hideAllOfType',
          JSON.stringify({
            id
          })
        )
      }
    }
  ]

  if (!noData) {
    menuData.splice(
      2,
      0,
      {
        label: proxy.capabilities.jsonData
          ? 'Copy JSON data'
          : 'Copy data',
        click: () => {
          sendToWindow(BrowserWindow.getAllWindows()[0],
            'copyPacketData',
            JSON.stringify({
              id
            })
          )
        }
      }
    )
  }

  if (
    !noData &&
    text.split(' ')[1] === 'position' &&
    direction === 'clientbound'
  ) {
    menuData.splice(
      3,
      0,
      {
        label: 'Copy teleport as command',
        click: () => {
          sendToWindow(BrowserWindow.getAllWindows()[0],
            'copyTeleportCommand',
            JSON.stringify({
              id
            })
          )
        }
      }
    )
  }

  if (proxy.capabilities.rawData) {
    menuData.splice(
      3,
      0,
      {
        label: 'Copy hex data',
        click: () => {
          sendToWindow(BrowserWindow.getAllWindows()[0],
            'copyHexData',
            JSON.stringify({
              id
            })
          )
        }
      }
    )
  }

  return Menu.buildFromTemplate(menuData)
}

function createWindow () {
  const win = new BrowserWindow({
    height: store.get('authConsentGiven') ? 550 : 650,
    width: 480,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    icon: resourcesPath + 'icons/icon.png'
  })

  win.setMenuBarVisibility(false)

  electronLocalShortcut.register(win, 'F12', () => {
    win.openDevTools()
  })

  win.webContents.setWindowOpenHandler(details => {
    shell.openExternal(details.url)

    return {
      action: 'deny'
    }
  })

  unhandled({
    logger: err => {
      sendToWindow(win,
        'error',
        JSON.stringify({
          msg: err.message,
          stack: err.stack
        })
      )

      console.log(err.stack)
      console.error(err)
    },
    showDialog: false
  })

  win.setMenu(null)

  if (options.autostart) {
    startProxy({
      consent: false,
      onlineMode: false,
      connectAddress: options.connect,
      connectPort: options.connectPort,
      listenPort: options.listenPort,
      platform: options.platform,
      version: options.version
    })
  } else {
    win.loadFile('html/startPage/index.html')
  }
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (proxy) {
      proxy.end()
    }

    if (activeLogSave) {
      activeLogSave.stream.destroy()
      activeLogSave = null
    }

    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

ipcMain.on('startProxy', (event, arg) => {
  const ipcMessage = JSON.parse(arg)
  startProxy(ipcMessage)
})

function showAuthCode (data) {
  const win = BrowserWindow.getAllWindows()[0]

  sendToWindow(win,
    'showAuthCode',
    JSON.stringify(data)
  )
}

function startProxy (args) {
  switch (args.platform) {
    case 'bedrock':
      proxy = bedrockProxy
      break

    case 'java':
      proxy = javaProxy
      break

    default:
      throw new Error(
        `Unsupported platform: ${args.platform}`
      )
  }

  const win = BrowserWindow.getAllWindows()[0]

  packetHandler.init(
    win,
    ipcMain,
    proxy
  )

  proxy.startProxy(
    args.connectAddress,
    args.connectPort,
    args.listenPort,
    args.version,
    args.onlineMode,
    args.consent,
    packetHandler.packetHandler,
    packetHandler.messageHandler,
    dataFolder,
    () => {
      sendToWindow(win, 'updateFiltering', '')
    },
    showAuthCode
  )

  win.loadFile('html/mainPage/index.html')

  const mainWindowState = windowStateKeeper({
    defaultWidth: 1000,
    defaultHeight: 800
  })

  win.setResizable(true)

  win.setSize(
    mainWindowState.width,
    mainWindowState.height
  )

  mainWindowState.manage(win)
}

ipcMain.on('proxyCapabilities', event => {
  event.returnValue = proxy.capabilities
})

ipcMain.on('copyToClipboard', (event, arg) => {
  clipboard.writeText(arg === undefined || arg === null ? '' : String(arg))
})

ipcMain.on('contextMenu', (event, arg) => {
  const ipcMessage = JSON.parse(arg)

  makeMenu(
    ipcMessage.direction,
    ipcMessage.text,
    ipcMessage.id,
    ipcMessage.invalid,
    ipcMessage.noData
  ).popup(BrowserWindow.getAllWindows()[0])
})

ipcMain.on('relaunchApp', () => {
  app.relaunch()
  app.exit()
})

function waitForStreamOpen (stream) {
  return new Promise((resolve, reject) => {
    if (!stream.pending) {
      resolve()
      return
    }

    const onOpen = () => {
      cleanup()
      resolve()
    }

    const onError = err => {
      cleanup()
      reject(err)
    }

    const cleanup = () => {
      stream.removeListener('open', onOpen)
      stream.removeListener('error', onError)
    }

    stream.once('open', onOpen)
    stream.once('error', onError)
  })
}

function writeToStream (stream, data) {
  return new Promise((resolve, reject) => {
    if (
      !stream ||
      stream.destroyed ||
      stream.writableEnded ||
      stream.closed
    ) {
      reject(
        new Error('Log stream is already closed')
      )
      return
    }

    let settled = false

    const cleanup = () => {
      stream.removeListener('error', onError)
      stream.removeListener('drain', onDrain)
    }

    const finishResolve = () => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      resolve()
    }

    const finishReject = err => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      reject(err)
    }

    const onError = err => {
      finishReject(err)
    }

    const onDrain = () => {
      finishResolve()
    }

    stream.once('error', onError)

    let canContinue

    try {
      canContinue = stream.write(data)
    } catch (err) {
      finishReject(err)
      return
    }

    if (canContinue) {
      finishResolve()
    } else {
      stream.once('drain', onDrain)
    }
  })
}

function finishStream (stream) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.destroyed) {
      reject(
        new Error('Cannot finish a destroyed stream')
      )
      return
    }

    let settled = false

    const cleanup = () => {
      stream.removeListener('finish', onFinish)
      stream.removeListener('error', onError)
    }

    const onFinish = () => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      resolve()
    }

    const onError = err => {
      if (settled) {
        return
      }

      settled = true
      cleanup()
      reject(err)
    }

    stream.once('finish', onFinish)
    stream.once('error', onError)

    stream.end()
  })
}

function resetActiveLogSave (sessionId) {
  if (
    activeLogSave &&
    activeLogSave.sessionId === sessionId
  ) {
    activeLogSave = null
  }
}

function getActiveSaveOrThrow (sessionId) {
  if (!activeLogSave) {
    throw new Error('No active log save')
  }

  if (!sessionId) {
    throw new Error('Missing save session ID')
  }

  if (activeLogSave.sessionId !== sessionId) {
    throw new Error(
      'Invalid or expired save session'
    )
  }

  return activeLogSave
}

ipcMain.handle('startSaveLog', async () => {
  const win = BrowserWindow.getAllWindows()[0]

  if (activeLogSave) {
    console.warn(
      'startSaveLog ignored because a save is already running:',
      activeLogSave.sessionId
    )

    return {
      canceled: false,
      busy: true,
      sessionId: activeLogSave.sessionId,
      filePath: activeLogSave.filePath,
      packetCount: activeLogSave.packetCount
    }
  }

  const result = await dialog.showSaveDialog(win, {
    title: 'Save packet log',
    filters: [
      {
        name: 'pakkit log files',
        extensions: ['pakkit-json']
      }
    ]
  })

  if (result.canceled || !result.filePath) {
    return {
      canceled: true,
      busy: false
    }
  }

  const filePath =
    result.filePath.endsWith('.pakkit-json')
      ? result.filePath
      : result.filePath + '.pakkit-json'

  const sessionId =
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`

  const stream = fs.createWriteStream(
    filePath,
    {
      flags: 'w',
      encoding: 'utf8',
      highWaterMark: 256 * 1024
    }
  )

  const saveState = {
    sessionId,
    filePath,
    stream,
    packetCount: 0,
    firstPacket: true,
    failed: null,
    queue: Promise.resolve(),
    finishing: false,
    canceled: false
  }

  activeLogSave = saveState

  stream.on('error', err => {
    saveState.failed = err

    console.error(
      'Log stream failed:',
      err
    )
  })

  try {
    await waitForStreamOpen(stream)
    await writeToStream(stream, '[')

    console.log(
      'Saving log to',
      filePath,
      'session:',
      sessionId
    )

    return {
      canceled: false,
      busy: false,
      sessionId,
      filePath
    }
  } catch (err) {
    saveState.failed = err
    stream.destroy()
    resetActiveLogSave(sessionId)

    try {
      await fs.promises.unlink(filePath)
    } catch (unlinkError) {
      if (unlinkError.code !== 'ENOENT') {
        console.error(
          'Could not remove failed save file:',
          unlinkError
        )
      }
    }

    throw err
  }
})


ipcMain.handle(
  'appendSaveLogChunk',
  async (event, request) => {
    if (
      !request ||
      typeof request !== 'object'
    ) {
      throw new TypeError(
        'Invalid appendSaveLogChunk request'
      )
    }

    const {
      sessionId,
      packets
    } = request

    const saveState =
      getActiveSaveOrThrow(sessionId)

    if (saveState.finishing) {
      throw new Error(
        'Log save is already finishing'
      )
    }

    if (saveState.canceled) {
      throw new Error(
        'Log save was canceled'
      )
    }

    if (!Array.isArray(packets)) {
      throw new TypeError(
        'packets must be an array'
      )
    }

    if (saveState.failed) {
      throw saveState.failed
    }

    saveState.queue =
      saveState.queue.then(async () => {
        if (saveState.failed) {
          throw saveState.failed
        }

        if (saveState.canceled) {
          throw new Error(
            'Log save was canceled'
          )
        }

        const serializedPackets = []

        for (const packet of packets) {
          const serialized = JSON.stringify(packet)

          if (serialized === undefined) {
            continue
          }

          serializedPackets.push(serialized)
          saveState.packetCount++
        }

        if (serializedPackets.length > 0) {
          let output = serializedPackets.join(',')

          if (!saveState.firstPacket) {
            output = ',' + output
          }

          saveState.firstPacket = false

          await writeToStream(
            saveState.stream,
            output
          )
        }
      })

    await saveState.queue

    return {
      success: true,
      packetCount: saveState.packetCount
    }
  }
)

ipcMain.handle(
  'finishSaveLog',
  async (event, request) => {
    if (
      !request ||
      typeof request !== 'object'
    ) {
      throw new TypeError(
        'Invalid finishSaveLog request'
      )
    }

    const {
      sessionId
    } = request

    const saveState =
      getActiveSaveOrThrow(sessionId)

    if (saveState.finishing) {
      throw new Error(
        'Log save is already finishing'
      )
    }

    saveState.finishing = true

    try {
      await saveState.queue

      if (saveState.failed) {
        throw saveState.failed
      }

      if (saveState.canceled) {
        throw new Error(
          'Log save was canceled'
        )
      }

      await writeToStream(
        saveState.stream,
        ']'
      )

      await finishStream(
        saveState.stream
      )

      console.log(
        `Saved ${saveState.packetCount} packets to ${saveState.filePath}`
      )

      return {
        success: true,
        filePath: saveState.filePath,
        packetCount: saveState.packetCount
      }
    } catch (err) {
      saveState.failed = err

      if (
        saveState.stream &&
        !saveState.stream.destroyed
      ) {
        saveState.stream.destroy()
      }

      throw err
    } finally {
      resetActiveLogSave(sessionId)
    }
  }
)

ipcMain.handle(
  'cancelSaveLog',
  async (event, request) => {
    if (
      !request ||
      typeof request !== 'object' ||
      !request.sessionId
    ) {
      console.warn(
        'Ignoring cancelSaveLog without sessionId'
      )

      return {
        success: false,
        ignored: true
      }
    }

    const saveState = activeLogSave

    if (!saveState) {
      return {
        success: true,
        alreadyClosed: true
      }
    }

    if (
      saveState.sessionId !==
      request.sessionId
    ) {
      console.warn(
        'Ignoring cancelSaveLog for another session'
      )

      return {
        success: false,
        ignored: true
      }
    }

    saveState.canceled = true

    resetActiveLogSave(
      saveState.sessionId
    )

    if (
      saveState.stream &&
      !saveState.stream.destroyed
    ) {
      saveState.stream.destroy()
    }

    try {
      await fs.promises.unlink(
        saveState.filePath
      )
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(
          'Could not remove canceled log file:',
          err
        )
      }
    }

    return {
      success: true
    }
  }
)

let activeLogLoad = null

function waitForRendererAck (webContents, channel, payload) {
  return new Promise((resolve, reject) => {
    const requestId =
      `${Date.now()}-${Math.random().toString(36).slice(2)}`

    const responseChannel =
      `${channel}-ack-${requestId}`

    const timeout = setTimeout(() => {
      ipcMain.removeAllListeners(responseChannel)

      reject(
        new Error(
          `Renderer did not acknowledge ${channel}`
        )
      )
    }, 30000)

    ipcMain.once(responseChannel, (event, response) => {
      clearTimeout(timeout)

      if (response && response.error) {
        reject(
          new Error(response.error)
        )
        return
      }

      resolve(response)
    })

    if (!sendToWindow({ webContents }, channel, {
      requestId,
      payload
    })) {
      clearTimeout(timeout)
      ipcMain.removeAllListeners(responseChannel)
      reject(new Error(`Renderer is unavailable for ${channel}`))
    }
  })
}

async function streamJsonArrayFile (
  filePath,
  onChunk,
  options = {}
) {
  const readChunkSize =
    options.readChunkSize || 1024 * 1024

  const outputChunkSize =
    options.outputChunkSize || 1000

  const outputChunkBytes =
    options.outputChunkBytes || 2 * 1024 * 1024

  const stream = fs.createReadStream(filePath, {
    encoding: 'utf8',
    highWaterMark: readChunkSize
  })

  let buffer = ''
  let scanIndex = 0

  let arrayStarted = false
  let arrayFinished = false

  let objectStart = -1
  let depth = 0
  let inString = false
  let escaped = false

  let packetChunk = []
  let packetChunkBytes = 0
  let packetCount = 0

  const flushPackets = async () => {
    if (packetChunk.length === 0) {
      return
    }

    const chunk = packetChunk
    packetChunk = []
    packetChunkBytes = 0

    await onChunk(chunk, packetCount)
  }

  for await (const data of stream) {
    buffer += data

    while (scanIndex < buffer.length) {
      const char = buffer[scanIndex]

      if (!arrayStarted) {
        if (/\s/.test(char)) {
          scanIndex++
          continue
        }

        if (char !== '[') {
          throw new Error(
            'Invalid pakkit log: expected JSON array'
          )
        }

        arrayStarted = true
        scanIndex++
        continue
      }

      if (arrayFinished) {
        if (!/\s/.test(char)) {
          throw new Error(
            'Invalid data after JSON array'
          )
        }

        scanIndex++
        continue
      }

      if (objectStart === -1) {
        if (
          /\s/.test(char) ||
          char === ','
        ) {
          scanIndex++
          continue
        }

        if (char === ']') {
          arrayFinished = true
          scanIndex++
          continue
        }

        if (char !== '{') {
          throw new Error(
            `Invalid packet JSON near character ${scanIndex}`
          )
        }

        objectStart = scanIndex
        depth = 1
        inString = false
        escaped = false
        scanIndex++
        continue
      }

      if (inString) {
        if (escaped) {
          escaped = false
          scanIndex++
          continue
        }

        if (char === '\\') {
          escaped = true
          scanIndex++
          continue
        }

        if (char === '"') {
          inString = false
        }

        scanIndex++
        continue
      }

      if (char === '"') {
        inString = true
        scanIndex++
        continue
      }

      if (char === '{' || char === '[') {
        depth++
        scanIndex++
        continue
      }

      if (char === '}' || char === ']') {
        depth--

        if (depth === 0) {
          const jsonText = buffer.slice(
            objectStart,
            scanIndex + 1
          )

          let packet

          try {
            packet = JSON.parse(jsonText)
          } catch (err) {
            throw new Error(
              `Invalid packet JSON near packet ${packetCount}: ${err.message}`
            )
          }

          packetChunk.push(packet)
          packetChunkBytes += Buffer.byteLength(jsonText, 'utf8')
          packetCount++

          scanIndex++
          objectStart = -1

          if (
            packetChunk.length >= outputChunkSize ||
            packetChunkBytes >= outputChunkBytes
          ) {
            await flushPackets()
          }

          buffer = buffer.slice(scanIndex)
          scanIndex = 0

          continue
        }

        scanIndex++
        continue
      }

      scanIndex++
    }

    if (objectStart === -1 && scanIndex > 0) {
      buffer = buffer.slice(scanIndex)
      scanIndex = 0
    }
  }

  if (!arrayStarted) {
    throw new Error(
      'Invalid pakkit log: empty file'
    )
  }

  if (objectStart !== -1) {
    throw new Error(
      'Invalid pakkit log: incomplete packet object'
    )
  }

  if (!arrayFinished) {
    throw new Error(
      'Invalid pakkit log: missing closing bracket'
    )
  }

  await flushPackets()

  return packetCount
}

ipcMain.handle('startLoadLog', async () => {
  const win = BrowserWindow.getAllWindows()[0]

  if (activeLogLoad) {
    return {
      canceled: false,
      busy: true
    }
  }

  const result = await dialog.showOpenDialog(
    win,
    {
      title: 'Load packet log',
      filters: [
        {
          name: 'pakkit log files',
          extensions: ['pakkit-json']
        },
        {
          name: 'All Files',
          extensions: ['*']
        }
      ],
      properties: ['openFile']
    }
  )

  if (
    result.canceled ||
    !result.filePaths ||
    !result.filePaths[0]
  ) {
    return {
      canceled: true,
      busy: false
    }
  }

  const filePath = result.filePaths[0]

  const loadId =
    `${Date.now()}-${Math.random().toString(36).slice(2)}`

  activeLogLoad = {
    loadId,
    filePath,
    canceled: false
  }

  const stat = await fs.promises.stat(filePath)

  console.log(
    'Loading log from',
    filePath
  )

  setImmediate(async () => {
    const loadState = activeLogLoad

    try {
      await waitForRendererAck(
        win.webContents,
        'loadLogStart',
        {
          loadId,
          filePath,
          fileSize: stat.size
        }
      )

      const packetCount =
        await streamJsonArrayFile(
          filePath,
          async packets => {
            if (
              !activeLogLoad ||
              activeLogLoad.loadId !== loadId ||
              loadState.canceled
            ) {
              throw new Error(
                'Log load canceled'
              )
            }

            await waitForRendererAck(
              win.webContents,
              'loadLogChunk',
              {
                loadId,
                packets
              }
            )
          },
          {
            readChunkSize: 1024 * 1024,
            outputChunkSize: 1000,
            outputChunkBytes: 2 * 1024 * 1024
          }
        )

      await waitForRendererAck(
        win.webContents,
        'loadLogFinish',
        {
          loadId,
          packetCount
        }
      )

      console.log(
        `Loaded ${packetCount} packets from ${filePath}`
      )
    } catch (err) {
      console.error(
        'Could not load log:',
        err
      )

      sendToWindow(win,
        'loadLogError',
        {
          loadId,
          error: err.message
        }
      )
    } finally {
      if (
        activeLogLoad &&
        activeLogLoad.loadId === loadId
      ) {
        activeLogLoad = null
      }
    }
  })

  return {
    canceled: false,
    busy: false,
    loadId,
    filePath,
    fileSize: stat.size
  }
})

ipcMain.handle('cancelLoadLog', async (event, request) => {
  if (!activeLogLoad) {
    return {
      success: true
    }
  }

  if (
    !request ||
    request.loadId !== activeLogLoad.loadId
  ) {
    return {
      success: false,
      ignored: true
    }
  }

  activeLogLoad.canceled = true

  return {
    success: true
  }
})

ipcMain.on(
  'saveAsScript',
  async (event, arg) => {
    const win =
      BrowserWindow.getAllWindows()[0]

    const result =
      await dialog.showSaveDialog(
        win,
        {
          title: 'Save user script',
          filters: [
            {
              name: 'javascript files',
              extensions: ['js']
            }
          ]
        }
      )

    if (
      result.canceled ||
      !result.filePath
    ) {
      return
    }

    const realPath =
      result.filePath.endsWith('.js')
        ? result.filePath
        : result.filePath + '.js'

    sendToWindow(win,
      'disableBtnScriptSave'
    )

    console.log(
      'Saving script to',
      realPath
    )

    fs.writeFile(
      realPath,
      arg,
      err => {
        if (err) {
          console.error(
            'Could not save script:',
            err
          )

          sendToWindow(win,
            'enableBtnScriptSave',
            currentScriptFile
          )

          return
        }

        console.log('Saved!')

        currentScriptFile = realPath

        sendToWindow(win,
          'enableBtnScriptSave',
          currentScriptFile
        )
      }
    )
  }
)

ipcMain.on(
  'saveScript',
  async (event, arg) => {
    const win =
      BrowserWindow.getAllWindows()[0]

    const validScriptPath =
      currentScriptFile !== null &&
      fs.existsSync(currentScriptFile)

    sendToWindow(win,
      'disableBtnScriptSave'
    )

    if (!validScriptPath) {
      console.error(
        'No valid script file selected'
      )

      sendToWindow(win,
        'enableBtnScriptSave',
        currentScriptFile
      )

      return
    }

    console.log(
      'Overwrite script to',
      currentScriptFile
    )

    fs.writeFile(
      currentScriptFile,
      arg,
      err => {
        if (err) {
          console.error(
            'Could not overwrite script:',
            err
          )

          sendToWindow(win,
            'enableBtnScriptSave',
            currentScriptFile
          )

          return
        }

        console.log('Saved!')

        sendToWindow(win,
          'enableBtnScriptSave',
          currentScriptFile
        )
      }
    )
  }
)

ipcMain.on(
  'loadScript',
  async () => {
    const win =
      BrowserWindow.getAllWindows()[0]

    const result =
      await dialog.showOpenDialog(
        win,
        {
          title: 'Load user script',
          filters: [
            {
              name: 'javascript files',
              extensions: ['js']
            }
          ],
          properties: ['openFile']
        }
      )

    if (
      result.canceled ||
      !result.filePaths ||
      !result.filePaths[0]
    ) {
      return
    }

    sendToWindow(win,
      'disableBtnScriptSave'
    )

    const filePath =
      result.filePaths[0]

    console.log(
      'Loading script from',
      filePath
    )

    fs.readFile(
      filePath,
      'utf8',
      (err, data) => {
        if (err) {
          console.error(
            'Could not load script:',
            err
          )

          sendToWindow(win,
            'enableBtnScriptSave',
            currentScriptFile
          )

          return
        }

        console.log(
          'File has been read'
        )

        currentScriptFile = filePath

        sendToWindow(win,
          'loadScriptData',
          data
        )

        sendToWindow(win,
          'enableBtnScriptSave',
          currentScriptFile
        )
      }
    )
  }
)
