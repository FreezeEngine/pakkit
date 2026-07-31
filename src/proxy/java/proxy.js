// Modified from:
// https://github.com/PrismarineJS/node-minecraft-protocol/blob/master/examples/proxy/proxy.js

const mc = require('minecraft-protocol')
const minecraftFolder = require('minecraft-folder-path')

const states = mc.states

let proxyServer
let realClient
let realServer
let toClientMappings = {}
let toServerMappings = {}
let storedCallback

let scriptingEnabled = false
let authWindowOpen = false

function isPortTaken (port, callback) {
  const net = require('net')

  const tester = net.createServer()
    .once('error', function (error) {
      if (error.code !== 'EADDRINUSE') {
        callback(error)
        return
      }

      callback(null, true)
    })
    .once('listening', function () {
      tester
        .once('close', function () {
          callback(null, false)
        })
        .close()
    })
    .listen(port)
}

function isPlayState (state) {
  return state === states.PLAY || state === 'play'
}

function isConfigurationState (state) {
  return state === states.CONFIGURATION || state === 'configuration'
}

function getMappingId (mappings, packetName) {
  if (!mappings || typeof packetName !== 'string') {
    return undefined
  }

  return Object.keys(mappings)
    .find(id => mappings[id] === packetName)
}

function safeCall (callback, ...args) {
  if (typeof callback === 'function') {
    try {
      callback(...args)
    } catch (error) {
      if (!String(error && error.message).toLowerCase().includes('destroyed')) {
        console.error(error)
      }
    }
  }
}

function createCustomPackets (mcdata) {
  const majorVersion = mcdata.version && mcdata.version.majorVersion
  if (!majorVersion) return undefined

  const particleType = mcdata.protocol &&
    mcdata.protocol.play &&
    mcdata.protocol.play.toClient &&
    mcdata.protocol.play.toClient.types &&
    mcdata.protocol.play.toClient.types.packet_world_particles

  if (!Array.isArray(particleType) || !Array.isArray(particleType[1])) {
    return undefined
  }

  const usesParticleRegistry = particleType[1]
    .some(field => field && field.type === 'Particle')

  if (!usesParticleRegistry) return undefined

  const fields = particleType[1].map((field, index) => ({
    name: index === 0 ? 'raw' : (field.name || `field${index}`),
    type: 'restBuffer'
  }))

  return {
    [majorVersion]: {
      play: {
        toClient: {
          types: {
            packet_world_particles: [
              'container',
              fields
            ]
          }
        }
      }
    }
  }
}

exports.capabilities = {
  modifyPackets: true,
  jsonData: true,
  rawData: true,
  scriptingSupport: true,
  clientboundPackets: [],
  serverboundPackets: [],
  wikiVgPage: 'https://wiki.vg/Protocol',
  versionId: undefined
}

exports.startProxy = function (
  host,
  port,
  listenPort,
  version,
  onlineMode,
  authConsent,
  callback,
  messageCallback,
  dataFolder,
  updateFilteringCallback,
  authCodeCallback
) {
  storedCallback = callback

  port = Number(port)
  listenPort = Number(listenPort)

  exports.capabilities.versionId =
    'java-node-minecraft-protocol-' +
    version.split('.').join('-')

  const mcdata = require('minecraft-data')(version)

  if (!mcdata) {
    safeCall(
      messageCallback,
      'Unable to start pakkit',
      `Minecraft data is unavailable for version ${version}`,
      true
    )
    return
  }

  const playProtocol = mcdata.protocol &&
    mcdata.protocol.play

  if (!playProtocol) {
    safeCall(
      messageCallback,
      'Unable to start pakkit',
      `Play protocol data is unavailable for version ${version}`,
      true
    )
    return
  }

  const clientPacketType =
    playProtocol.toClient &&
    playProtocol.toClient.types &&
    playProtocol.toClient.types.packet &&
    playProtocol.toClient.types.packet[1] &&
    playProtocol.toClient.types.packet[1][0] &&
    playProtocol.toClient.types.packet[1][0].type &&
    playProtocol.toClient.types.packet[1][0].type[1]

  const serverPacketType =
    playProtocol.toServer &&
    playProtocol.toServer.types &&
    playProtocol.toServer.types.packet &&
    playProtocol.toServer.types.packet[1] &&
    playProtocol.toServer.types.packet[1][0] &&
    playProtocol.toServer.types.packet[1][0].type &&
    playProtocol.toServer.types.packet[1][0].type[1]

  toClientMappings =
    (clientPacketType && clientPacketType.mappings) || {}

  toServerMappings =
    (serverPacketType && serverPacketType.mappings) || {}

  exports.capabilities.clientboundPackets = toClientMappings
  exports.capabilities.serverboundPackets = toServerMappings

  const customPackets = createCustomPackets(mcdata)

  const separatorIndex = host.lastIndexOf(':')

  if (
    separatorIndex !== -1 &&
    host.indexOf(':') === separatorIndex
  ) {
    const hostPort = Number(host.substring(separatorIndex + 1))

    if (Number.isFinite(hostPort)) {
      port = hostPort
      host = host.substring(0, separatorIndex)
    }
  }

  isPortTaken(listenPort, function (error, taken) {
    if (error) {
      safeCall(
        messageCallback,
        'Unable to start pakkit',
        error.message,
        true
      )
      return
    }

    if (taken) {
      safeCall(
        messageCallback,
        'Unable to start pakkit',
        `The port ${listenPort} is in use. ` +
        'Close other Pakkit instances or choose another port.',
        true
      )
      return
    }

    try {
      proxyServer = mc.createServer({
        'online-mode': false,
        port: listenPort,
        keepAlive: false,
        disableDefaultConfiguration: true,
        customPackets,
        hideErrors: true,
        version
      })
    } catch (error) {
      safeCall(
        messageCallback,
        'Unable to start pakkit',
        error.message,
        true
      )
      return
    }

    console.log('Proxy started (Java)!')

    proxyServer.on('login', function (client) {
      realClient = client

      const remoteAddress =
        client.socket && client.socket.remoteAddress

      console.log(
        'Incoming connection',
        `(${remoteAddress || 'unknown'})`
      )

      let endedClient = false
      let endedTargetClient = false

      const pendingClientbound = []
      const pendingServerbound = []

      const MAX_PENDING_CLIENTBOUND = 4096
      const MAX_PENDING_SERVERBOUND = 512

      const forwardingErrors = new Set()

      const clientOptions = {
        host,
        port,
        username: client.username,
        keepAlive: false,
        version,
        profilesFolder: authConsent
          ? minecraftFolder
          : dataFolder,
        auth: onlineMode
          ? 'microsoft'
          : 'offline',
        customPackets,
        hideErrors: true,

        onMsaCode: function (data) {
          authWindowOpen = true

          safeCall(authCodeCallback, data)
        }
      }

      const targetClient = mc.createClient(clientOptions)

      realServer = targetClient

      client.on('disconnect', reason => {
        console.error('Client disconnect packet:', reason)
      })
      client.on('kick_disconnect', reason => {
        console.error('Client kick disconnect:', reason)
      })
      targetClient.on('kick_disconnect', reason => {
        console.error('Server disconnect packet:', reason)
      })
      targetClient.on('disconnect', reason => {
        console.error('Server disconnect:', reason)
      })

      function bothSidesReady () {
        return !endedClient &&
          !endedTargetClient &&
          isPlayState(client.state) &&
          isPlayState(targetClient.state)
      }

      function enqueuePacket (
        queue,
        maxSize,
        data,
        meta,
        raw
      ) {
        if (queue.length >= maxSize) {
          queue.shift()
        }

        queue.push({
          data,
          meta: Object.assign({}, meta),
          raw
        })
      }

      function reportForwardingError (
        direction,
        meta,
        error
      ) {
        const packetName =
          meta && meta.name !== undefined
            ? meta.name
            : 'unknown'

        const state =
          meta && meta.state !== undefined
            ? meta.state
            : 'unknown'

        const key =
          `${direction}:${state}:${packetName}`

        if (forwardingErrors.has(key)) {
          return
        }

        forwardingErrors.add(key)

        console.error(
          `Failed to forward ${key}: ${error.message}`
        )
      }

      function forwardPacket (
        destination,
        meta,
        data,
        direction,
        raw
      ) {
        if (!destination || !meta) {
          return false
        }

        if (typeof meta.name !== 'string') {
          return false
        }

        try {
          if (raw) {
            destination.writeRaw(raw)
          } else {
            destination.write(meta.name, data)
          }
          return true
        } catch (error) {
          reportForwardingError(
            direction,
            meta,
            error
          )

          return false
        }
      }

      function notifyPacket (
        direction,
        meta,
        data,
        mappings,
        raw
      ) {
        const id = typeof meta.name === 'number'
          ? `0x${meta.name.toString(16).padStart(2, '0')}`
          : getMappingId(mappings, meta.name)

        safeCall(
          callback,
          direction,
          meta,
          data,
          id,
          true,
          true,
          raw
        )
      }

      function handleServerboundPacket (
        data,
        meta,
        fromQueue,
        raw
      ) {
        if (
          !meta ||
          (!isPlayState(meta.state) &&
            !isConfigurationState(meta.state))
        ) {
          return
        }

        if (endedTargetClient) {
          return
        }

        if (isPlayState(meta.state) && !bothSidesReady()) {
          if (!fromQueue) {
            enqueuePacket(
              pendingServerbound,
              MAX_PENDING_SERVERBOUND,
              data,
              meta,
              raw
            )
          }

          return
        }

        if (isConfigurationState(meta.state)) {
          const handledByTargetClient = new Set([
            'select_known_packs',
            'finish_configuration',
            'accept_code_of_conduct'
          ])

          if (handledByTargetClient.has(meta.name)) {
            return
          }

          if (!isConfigurationState(targetClient.state)) {
            if (!fromQueue) {
              enqueuePacket(
                pendingServerbound,
                MAX_PENDING_SERVERBOUND,
                data,
                meta,
                raw
              )
            }
            return
          }
        }

        if (!scriptingEnabled) {
          const forwarded = forwardPacket(
            targetClient,
            meta,
            data,
            'serverbound',
            isPlayState(meta.state) ? raw : undefined
          )

          if (!forwarded) {
            return
          }
        }

        if (isPlayState(meta.state)) {
          notifyPacket('serverbound', meta, data, toServerMappings, raw)
        }
      }

      function handleClientboundPacket (
        data,
        meta,
        fromQueue,
        raw
      ) {
        if (
          !meta ||
          (!isConfigurationState(meta.state) &&
            !isPlayState(meta.state))
        ) {
          return
        }

        if (endedClient) {
          return
        }

        if (isPlayState(meta.state) && !bothSidesReady()) {
          if (!fromQueue) {
            enqueuePacket(
              pendingClientbound,
              MAX_PENDING_CLIENTBOUND,
              data,
              meta,
              raw
            )
          }

          return
        }

        if (!scriptingEnabled) {
          const forwarded = forwardPacket(
            client,
            meta,
            data,
            'clientbound',
            raw
          )

          if (!forwarded) {
            return
          }
        }

        if (isPlayState(meta.state)) {
          notifyPacket('clientbound', meta, data, toClientMappings, raw)
        }
      }

      function flushPendingPackets () {
        while (bothSidesReady() && pendingClientbound.length > 0) {
          const packet = pendingClientbound.shift()

          handleClientboundPacket(
            packet.data,
            packet.meta,
            true,
            packet.raw
          )
        }

        const pendingCount = pendingServerbound.length
        for (let i = 0; i < pendingCount; i++) {
          const packet = pendingServerbound.shift()

          const ready = isPlayState(packet.meta.state)
            ? bothSidesReady()
            : isConfigurationState(targetClient.state)

          if (!ready) {
            pendingServerbound.push(packet)
            continue
          }

          handleServerboundPacket(
            packet.data,
            packet.meta,
            true,
            packet.raw
          )
        }
      }

      const readinessTimer = setInterval(function () {
        if (endedClient || endedTargetClient) {
          clearInterval(readinessTimer)
          return
        }

        flushPendingPackets()
      }, 10)

      if (
        typeof readinessTimer.unref === 'function'
      ) {
        readinessTimer.unref()
      }

      client.on('packet', function (data, meta, buffer, fullBuffer) {
        handleServerboundPacket(
          data,
          meta,
          false,
          fullBuffer || buffer
        )
      })

      targetClient.on(
        'packet',
        function (data, meta, buffer, fullBuffer) {
          handleClientboundPacket(
            data,
            meta,
            false,
            fullBuffer || buffer
          )
        }
      )

      targetClient.on('session', function () {
        authWindowOpen = false

        safeCall(authCodeCallback, 'close')
      })

      client.on('end', function () {
        if (endedClient) {
          return
        }

        endedClient = true
        clearInterval(readinessTimer)

        pendingClientbound.length = 0
        pendingServerbound.length = 0

        console.log(
          'Connection closed by client',
          `(${remoteAddress || 'unknown'})`
        )

        if (!endedTargetClient) {
          try {
            targetClient.end('End')
          } catch (error) {}
        }
      })

      client.on('error', function (error) {
        if (endedClient) {
          return
        }

        endedClient = true
        clearInterval(readinessTimer)

        pendingClientbound.length = 0
        pendingServerbound.length = 0

        console.error(
          'Connection error by client:',
          error.message
        )

        if (!endedTargetClient) {
          try {
            targetClient.end('Error')
          } catch (endError) {}
        }
      })

      targetClient.on('end', function () {
        if (endedTargetClient) {
          return
        }

        endedTargetClient = true
        clearInterval(readinessTimer)

        pendingClientbound.length = 0
        pendingServerbound.length = 0

        console.log(
          'Connection closed by server',
          `(${host}:${port})`
        )

        if (!endedClient) {
          try {
            client.end(
              `Connection closed by server (${host}:${port})`
            )
          } catch (error) {}
        }
      })

      targetClient.on('error', function (error) {
        if (endedTargetClient) {
          return
        }

        endedTargetClient = true
        clearInterval(readinessTimer)

        pendingClientbound.length = 0
        pendingServerbound.length = 0

        console.error(
          `Connection error by server (${host}:${port}):`,
          error.message
        )

        if (authWindowOpen) {
          return
        }

        let message = error.message

        if (
          error.message &&
          error.message.includes('ECONNREFUSED')
        ) {
          message =
            `Unable to connect to ${host}:${port}. ` +
            'Make sure the server is online.'
        }

        safeCall(
          messageCallback,
          'Unable to connect to server',
          message,
          true
        )

        if (!endedClient) {
          try {
            client.end(
              'pakkit - Unable to connect to server\n' +
              message
            )
          } catch (endError) {}
        }
      })
    })

    proxyServer.on('error', function (error) {
      safeCall(
        messageCallback,
        'Pakkit proxy error',
        error.message,
        true
      )
    })
  })
}

exports.end = function () {
  if (realClient) {
    try {
      realClient.end('Proxy stopped')
    } catch (error) {}

    realClient = undefined
  }

  if (realServer) {
    try {
      realServer.end('Proxy stopped')
    } catch (error) {}

    realServer = undefined
  }

  if (proxyServer) {
    try {
      if (
        typeof proxyServer.close === 'function'
      ) {
        proxyServer.close()
      } else if (
        proxyServer.socketServer &&
        typeof proxyServer.socketServer.close === 'function'
      ) {
        proxyServer.socketServer.close()
      }
    } catch (error) {}

    proxyServer = undefined
  }
}

exports.getRaw = function (
  direction,
  name,
  params
) {
  const connection =
    direction === 'serverbound'
      ? realServer
      : realClient

  if (
    !connection ||
    !connection.serializer
  ) {
    return undefined
  }

  try {
    return connection.serializer
      .createPacketBuffer({
        name,
        params
      })
  } catch (error) {
    return undefined
  }
}

exports.writeToClient = function (
  meta,
  data,
  noCallback
) {
  if (!realClient) {
    return false
  }

  if (typeof meta === 'string') {
    meta = {
      name: meta,
      state: states.PLAY
    }
  }

  try {
    realClient.write(meta.name, data)
  } catch (error) {
    return false
  }

  const id = getMappingId(
    toClientMappings,
    meta.name
  )

  if (
    !noCallback &&
    typeof storedCallback === 'function'
  ) {
    storedCallback(
      'clientbound',
      meta,
      data,
      id,
      true,
      true
    )
  }

  return true
}

exports.writeToServer = function (
  meta,
  data,
  noCallback
) {
  if (!realServer) {
    return false
  }

  if (typeof meta === 'string') {
    meta = {
      name: meta,
      state: states.PLAY
    }
  }

  try {
    realServer.write(meta.name, data)
  } catch (error) {
    return false
  }

  const id = getMappingId(
    toServerMappings,
    meta.name
  )

  if (
    !noCallback &&
    typeof storedCallback === 'function'
  ) {
    storedCallback(
      'serverbound',
      meta,
      data,
      id,
      true,
      true
    )
  }

  return true
}

exports.setScriptingEnabled = function (
  isEnabled
) {
  scriptingEnabled = Boolean(isEnabled)
}
