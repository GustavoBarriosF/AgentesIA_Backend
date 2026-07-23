'use strict'

require('dotenv').config()

const Fastify = require('fastify')
const fp = require('fastify-plugin')
const cors = require('@fastify/cors')
const helmet = require('@fastify/helmet')
const multipart = require('@fastify/multipart')

const { connectDB } = require('./db/connect')
const { getRedis, closeRedis } = require('./db/redis')
const logger = require('./utils/logger')

// Precargar modelos Mongoose
require('./db/models/workspace')
require('./db/models/user')
require('./db/models/workspace-member')
require('./db/models/plan')
require('./db/models/plan-definition')
require('./db/models/super-admin')
require('./db/models/coupon')
require('./db/models/invoice')
require('./db/models/channel')
require('./db/models/department')
require('./db/models/agent')
require('./db/models/contact')
require('./db/models/conversation')
require('./db/models/message')
require('./db/models/attachment')
require('./db/models/lead')
require('./db/models/ticket')
require('./db/models/knowledge-item')
require('./db/models/bot-agent')
require('./db/models/ai-provider')
require('./db/models/product')
require('./db/models/payment-gateway')
require('./db/models/payment-link')
require('./db/models/erp-integration')
require('./db/models/campaign')
require('./db/models/campaign-contact')

// Jobs
const { startSLAMonitor }        = require('./jobs/sla-monitor')
const { startAbandonedJob }      = require('./jobs/abandoned-conversations')
const { startUsageResetJob }     = require('./jobs/usage-reset')
const { startQueueProcessor }    = require('./jobs/queue-processor')
const { startCampaignProcessor } = require('./jobs/campaign-processor')

// Servicios con estado propio
const baileysService = require('./services/baileys.service')

async function buildApp() {
  const app = Fastify({
    logger: false, // Usamos pino directamente
    trustProxy: true,
    // AJV: permitir keywords de OpenAPI (example, description en body, etc.)
    ajv: {
      customOptions: {
        strict: false,
        keywords: ['example'],
      },
    },
  })

  // ─── Seguridad ─────────────────────────────────────────────────────────────
  await app.register(helmet, {
    contentSecurityPolicy: false, // Desactivar para API
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Permitir carga de imágenes desde otros orígenes (admin, widget)
  })

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  })

  // ─── Multipart (uploads) ───────────────────────────────────────────────────
  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  })

  // ─── Archivos locales (fallback cuando R2 no está configurado) ───────────
  if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID) {
    const nodePath = require('path')
    const nodeFs   = require('fs')
    const uploadsDir = nodePath.join(__dirname, '../uploads')
    nodeFs.mkdirSync(uploadsDir, { recursive: true })

    const MIME_MAP = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif',  '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.mp4': 'video/mp4',  '.webm': 'video/webm',
      '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',  '.wav': 'audio/wav',
      '.pdf': 'application/pdf',
    }

    app.get('/uploads/*', {
      config: { rawBody: false },
    }, async (request, reply) => {
      const rel      = request.params['*']
      const filePath = nodePath.join(uploadsDir, rel)
      // Evitar path traversal
      if (!filePath.startsWith(uploadsDir)) return reply.code(403).send()
      if (!nodeFs.existsSync(filePath)) return reply.code(404).send()

      const ext         = nodePath.extname(filePath).toLowerCase()
      const contentType = MIME_MAP[ext] || 'application/octet-stream'
      reply.header('Content-Type', contentType)
      reply.header('Cache-Control', 'public, max-age=31536000')
      return reply.send(nodeFs.createReadStream(filePath))
    })
  }

  // ─── Swagger / OpenAPI (debe registrarse ANTES de las rutas) ─────────────
  await app.register(require('./plugins/swagger'))

  // ─── Plugins propios ───────────────────────────────────────────────────────
  await app.register(require('./plugins/auth'))
  await app.register(require('./plugins/superadmin-auth'))
  await app.register(require('./plugins/multitenancy'))
  await app.register(require('./plugins/plan-enforcement'))
  await app.register(require('./plugins/ratelimit'))
  await app.register(require('./plugins/websocket'))

  // ─── Raw body para webhooks ────────────────────────────────────────────────
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body
    try {
      done(null, JSON.parse(body))
    } catch (err) {
      done(err)
    }
  })

  // ─── Manejador global de errores ───────────────────────────────────────────
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || error.status || 500
    logger.error({ err: error, url: request.url, method: request.method }, 'Error en request')

    if (statusCode === 400 && error.validation) {
      return reply.code(400).send({
        error: 'Datos de entrada invalidos',
        details: error.validation,
      })
    }

    if (error.code === 'plan_limit_reached') {
      return reply.code(403).send({
        error: error.code,
        message: error.message,
        resource: error.resource,
        limit: error.limit,
        used: error.used,
      })
    }

    return reply.code(statusCode).send({
      error: statusCode < 500 ? error.message : 'Error interno del servidor',
    })
  })

  // ─── Rutas ─────────────────────────────────────────────────────────────────

  // Auth (sin workspace)
  app.register(require('./routes/auth'), { prefix: '/auth' })

  // SuperAdmin (auth separada, sin workspace)
  app.register(require('./routes/superadmin/auth'),             { prefix: '/superadmin/auth' })
  app.register(require('./routes/superadmin/dashboard'),        { prefix: '/superadmin' })
  app.register(require('./routes/superadmin/workspaces'),       { prefix: '/superadmin/workspaces' })
  app.register(require('./routes/superadmin/plan-definitions'), { prefix: '/superadmin/plan-definitions' })
  app.register(require('./routes/superadmin/coupons'),          { prefix: '/superadmin/coupons' })
  app.register(require('./routes/superadmin/billing'),          { prefix: '/superadmin/billing' })

  // Webhooks (sin autenticacion JWT, con su propia verificacion)
  app.register(require('./routes/webhooks'), { prefix: '/webhooks' })

  // Widget (público, sin auth JWT)
  app.register(require('./routes/widget'), { prefix: '/widget' })

  // API bajo workspace
  app.register(async (instance) => {
    instance.register(require('./routes/workspaces'), { prefix: '/api/:workspaceId' })
    instance.register(require('./routes/channels'), { prefix: '/api/:workspaceId/channels' })
    instance.register(require('./routes/agents'), { prefix: '/api/:workspaceId/agents' })
    instance.register(require('./routes/contacts'), { prefix: '/api/:workspaceId/contacts' })
    instance.register(require('./routes/conversations'), { prefix: '/api/:workspaceId/conversations' })
    instance.register(require('./routes/messages'), { prefix: '/api/:workspaceId/messages' })
    instance.register(require('./routes/knowledge'), { prefix: '/api/:workspaceId/knowledge' })
    instance.register(require('./routes/tickets'), { prefix: '/api/:workspaceId/tickets' })
    instance.register(require('./routes/leads'), { prefix: '/api/:workspaceId/leads' })
    instance.register(require('./routes/analytics'), { prefix: '/api/:workspaceId/analytics' })
    instance.register(require('./routes/bots'),             { prefix: '/api/:workspaceId/bots' })
    instance.register(require('./routes/plans'),            { prefix: '/api/:workspaceId/plans' })
    instance.register(require('./routes/ai-providers'),     { prefix: '/api/:workspaceId/ai-providers' })
    instance.register(require('./routes/products'),         { prefix: '/api/:workspaceId/products' })
    instance.register(require('./routes/payment-gateways'), { prefix: '/api/:workspaceId/payment-gateways' })
    instance.register(require('./routes/payment-links'),    { prefix: '/api/:workspaceId/payment-links' })
    // ERP: gestión de integraciones (CRUD) + operaciones directas (consultas/facturas)
    instance.register(require('./routes/erp-integrations'), { prefix: '/api/:workspaceId' })
    instance.register(require('./routes/campaigns'),        { prefix: '/api/:workspaceId/campaigns' })
    instance.register(require('./routes/baileys'),          { prefix: '/api/:workspaceId/channels' })
  })

  // Health check
  app.get('/health', {
    schema: {
      tags: ['Health'],
      summary: 'Estado del servidor',
      description: 'Verifica que el servidor está operativo. No requiere autenticación.',
      response: {
        200: {
          type: 'object',
          properties: {
            status:    { type: 'string', enum: ['ok'] },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  }, async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

  return app
}

async function start() {
  try {
    // Conectar bases de datos
    await connectDB()
    getRedis() // Inicializar conexion Redis

    const app = await buildApp()

    const port = parseInt(process.env.PORT || '3000')
    const host = process.env.HOST || '0.0.0.0'

    await app.listen({ port, host })
    logger.info(`Servidor NexoraChat corriendo en http://${host}:${port}`)

    // Iniciar jobs de background
    if (process.env.NODE_ENV !== 'test') {
      startSLAMonitor()
      startAbandonedJob({ widgetIo: app.widgetIo, io: app.io })
      startUsageResetJob()
      startQueueProcessor()
      startCampaignProcessor()

      // Inicializar Baileys e restaurar sesiones activas
      baileysService.init(app)
      baileysService.restoreAllSessions().catch(() => {})
    }

    // Shutdown graceful
    const shutdown = async (signal) => {
      logger.info({ signal }, 'Apagando servidor...')
      await app.close()
      await closeRedis()
      process.exit(0)
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))

  } catch (err) {
    logger.error({ err }, 'Error al iniciar el servidor')
    process.exit(1)
  }
}

start()
