'use strict'

const fp = require('fastify-plugin')
const { Server: SocketIO } = require('socket.io')
const { jwtVerify } = require('jose')
const { getRedis } = require('../db/redis')
const crypto = require('crypto')
const logger = require('../utils/logger')

async function websocketPlugin(fastify) {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET || 'dev-secret-change-in-production')

  const allowedOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(o => o.trim().replace(/\/$/, ''))
    .filter(Boolean)

  const io = new SocketIO(fastify.server, {
    cors: {
      origin: allowedOrigins.length ? allowedOrigins : '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  })

  // Autenticacion del handshake
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.slice(7)
      if (!token) return next(new Error('Token requerido'))

      const { payload } = await jwtVerify(token, secret)

      // Verificar sesion en Redis
      const hash = crypto.createHash('sha256').update(token).digest('hex')
      const redis = getRedis()
      const sessionExists = await redis.exists(`session:${hash}`)
      if (!sessionExists) return next(new Error('Sesion invalida'))

      socket.user = payload
      next()
    } catch (err) {
      next(new Error('Token invalido'))
    }
  })

  io.on('connection', async (socket) => {
    const userId = socket.user.sub
    const workspaces = socket.user.workspaces || []
    const redis = getRedis()

    // Datos del agente conocidos tras el primer heartbeat (para usarlos en disconnect)
    let lastAgentWorkspaceId = null
    let lastAgentId = null

    logger.debug({ userId }, 'WebSocket conectado')

    // Unir al usuario a rooms de sus workspaces
    for (const ws of workspaces) {
      socket.join(`workspace:${ws.id}`)
    }

    // Guardar socket ID en Redis
    await redis.set(`ws:conn:${userId}`, socket.id, 'EX', 30)

    // Heartbeat: el cliente envia ping cada 25s
    socket.on('heartbeat', async (data) => {
      try {
        await redis.set(`ws:conn:${userId}`, socket.id, 'EX', 30)

        // Actualizar presencia del agente si corresponde
        if (data?.workspaceId && data?.agentId) {
          const wsId = String(data.workspaceId)
          const aId = String(data.agentId)
          const agentStatus = data.status || 'online'
          await redis.set(`agent:status:${wsId}:${aId}`, agentStatus, 'EX', 30)
          if (agentStatus === 'online') {
            await redis.sadd(`agents:online:${wsId}`, aId)
            // Bug 3: TTL alineado a 35s (5s más que status:30s) para minimizar ventana de inconsistencia
            await redis.expire(`agents:online:${wsId}`, 35)
          } else {
            await redis.srem(`agents:online:${wsId}`, aId)
          }
          // Cachear para usarlo en disconnect (en closure y en Redis)
          lastAgentWorkspaceId = wsId
          lastAgentId = aId
          await redis.set(`agent:ws_info:${userId}`, JSON.stringify({ workspaceId: wsId, agentId: aId }), 'EX', 60)
        }
      } catch (err) {
        logger.warn({ err, userId }, 'Error Redis en heartbeat')
      }
    })

    // Unirse a room de una conversacion especifica
    socket.on('join:conversation', (convId) => {
      socket.join(`conv:${convId}`)
    })

    // Salir de room de conversacion
    socket.on('leave:conversation', (convId) => {
      socket.leave(`conv:${convId}`)
    })

    socket.on('disconnect', async () => {
      logger.debug({ userId }, 'WebSocket desconectado')
      try {
        await redis.del(`ws:conn:${userId}`)

        // Fix 2: Intentar recuperar workspaceId desde Redis si el agente se desconectó
        // antes del primer heartbeat (lastAgentWorkspaceId / lastAgentId serían null)
        let wsId = lastAgentWorkspaceId
        let aId = lastAgentId
        if (!wsId || !aId) {
          const wsInfo = await redis.get(`agent:ws_info:${userId}`)
          if (wsInfo) {
            try {
              const parsed = JSON.parse(wsInfo)
              wsId = parsed.workspaceId
              aId = parsed.agentId
            } catch (_) { /* ignorar parse error */ }
          }
        }

        // Remover al agente del Set de online si estaba registrado
        if (wsId && aId) {
          await redis.srem(`agents:online:${wsId}`, aId)
        }
      } catch (err) {
        logger.warn({ err, userId }, 'Error Redis en disconnect')
      }
    })
  })

  // ── Namespace /widget — sin JWT, autenticado por session_id ──────────────
  // Permite que el widget del visitante reciba mensajes en tiempo real
  const widgetNs = io.of('/widget')

  widgetNs.on('connection', (socket) => {
    const sessionId = socket.handshake.auth?.session_id
    if (!sessionId) { socket.disconnect(true); return }
    socket.sessionId = sessionId

    logger.debug({ sessionId }, 'Widget WebSocket conectado')

    // El widget se une a la room de su conversación
    socket.on('join:conversation', (data, callback) => {
      const convId = typeof data === 'object' ? data.conversationId : data
      if (convId) socket.join(`conv:${convId}`)
      if (typeof callback === 'function') callback({ ok: true })
    })

    socket.on('disconnect', () => {
      logger.debug({ sessionId }, 'Widget WebSocket desconectado')
    })
  })

  // Exponer io para que los servicios puedan hacer emit
  fastify.decorate('io', io)
  fastify.decorate('widgetIo', widgetNs)

  fastify.addHook('onClose', async () => {
    io.close()
  })
}

module.exports = fp(websocketPlugin, { name: 'websocket' })
