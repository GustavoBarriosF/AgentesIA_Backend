'use strict'

const channelService = require('../../services/channel.service')
const Workspace = require('../../db/models/workspace')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

const CHANNEL_TYPES = ['web_widget', 'whatsapp', 'whatsapp_baileys', 'telegram', 'api', 'facebook_messenger', 'instagram_dm', 'email', 'slack', 'teams', 'sms', 'line']

const ChannelObject = {
  type: 'object',
  properties: {
    _id:          { type: 'string' },
    workspace_id: { type: 'string' },
    name:         { type: 'string', description: 'Nombre descriptivo del canal' },
    type:         { type: 'string', enum: CHANNEL_TYPES },
    config:       {
      type: 'object',
      additionalProperties: true,
      description: [
        'Configuración según tipo de canal:',
        '- **whatsapp**: `phone_number_id`, `access_token`, `app_secret`, `verify_token`',
        '- **telegram**: `bot_token`, `bot_username`',
        '- **web_widget**: `allowed_domains`, `welcome_message`, `color`',
        '- **api**: `api_key`',
        '- **facebook_messenger**: `page_id`, `access_token`, `app_secret`, `verify_token`',
        '- **instagram_dm**: `ig_account_id`, `page_id`, `access_token`, `app_secret`, `verify_token`',
        '- **slack**: `bot_token`, `team_id`, `team_name`, `signing_secret`, `bot_user_id` (auto-poblado por OAuth)',
        '- **teams**: `app_id`, `app_password` (Azure Bot Registration credentials)',
        '- **sms**: `provider` (twilio|vonage|sns), `phone_number` (E.164). Twilio: `account_sid`, `auth_token`. Vonage: `api_key`, `api_secret`. SNS: `aws_access_key_id`, `aws_secret_access_key`, `aws_region`',
        '- **line**: `channel_access_token`, `channel_secret`, `channel_id`',
      ].join('\n'),
    },
    active:      { type: 'boolean' },
    createdAt:   { type: 'string', format: 'date-time' },
    updatedAt:   { type: 'string', format: 'date-time' },
  },
}

async function channelRoutes(fastify) {
  const preHandler  = [fastify.authenticate, fastify.requireWorkspace]
  const adminHandler = [...preHandler, fastify.requireRole('admin')]

  // ─── GET /api/:workspaceId/channels ───────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Channels'],
      summary: 'Listar canales',
      description: 'Retorna todos los canales de comunicación del workspace.',
      security,
      params: workspaceParam,
      response: {
        200: { description: 'Lista de canales', type: 'array', items: ChannelObject },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    return channelService.listChannels(request.workspaceId)
  })

  // ─── POST /api/:workspaceId/channels ──────────────────────────────────────
  fastify.post('/', {
    preHandler: adminHandler,
    schema: {
      tags: ['Channels'],
      summary: 'Crear canal',
      description: [
        'Crea un nuevo canal de comunicación. **Requiere rol admin.**',
        '',
        '### Configuración por tipo:',
        '',
        '**WhatsApp** — cada cliente usa su propia Meta App (SaaS):',
        '```json',
        '{',
        '  "phone_number_id": "123456789",',
        '  "access_token": "EAAxxxx...",',
        '  "app_secret": "abc123...",',
        '  "verify_token": "mi_token_secreto_unico"',
        '}',
        '```',
        '',
        '**Telegram**:',
        '```json',
        '{ "bot_token": "123:ABCxxx...", "bot_username": "MiBot" }',
        '```',
        '',
        '**Web Widget**:',
        '```json',
        '{ "allowed_domains": ["miempresa.com"], "welcome_message": "¡Hola!", "color": "#4F46E5" }',
        '```',
      ].join('\n'),
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name:   { type: 'string', example: 'WhatsApp Principal', description: 'Nombre descriptivo' },
          type:   { type: 'string', enum: CHANNEL_TYPES, example: 'whatsapp' },
          config: { type: 'object', description: 'Configuración específica del canal (ver descripción)' },
        },
      },
      response: {
        201: { description: 'Canal creado', ...ChannelObject },
        400: { description: 'Datos inválidos', ...errorResponse },
        403: { description: 'Se requiere rol admin', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    await fastify.checkLimit(request.workspaceId, 'channel')

    const { type, config = {} } = request.body
    if (type === 'instagram_dm') {
      if (!config?.page_id || !config?.access_token || !config?.ig_account_id) {
        return reply.code(400).send({
          error: 'Los canales de Instagram requieren: page_id, access_token e ig_account_id',
        })
      }
    }

    if (type === 'email') {
      if (!config?.inbox_address || !config?.smtp_host || !config?.smtp_user || !config?.smtp_password) {
        return reply.code(400).send({
          error: 'Los canales de email requieren: inbox_address, smtp_host, smtp_user y smtp_password',
        })
      }
    }

    const channel = await channelService.createChannel(request.workspaceId, request.body)
    return reply.code(201).send(channel)
  })

  // ─── GET /api/:workspaceId/channels/:channelId ────────────────────────────
  fastify.get('/:channelId', {
    preHandler,
    schema: {
      tags: ['Channels'],
      summary: 'Obtener canal',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'channelId'],
        properties: {
          workspaceId: { type: 'string' },
          channelId:   { type: 'string', description: 'ID del canal' },
        },
      },
      response: {
        200: { description: 'Canal encontrado', ...ChannelObject },
        404: { description: 'Canal no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    return channelService.getChannel(request.workspaceId, request.params.channelId)
  })

  // ─── PATCH /api/:workspaceId/channels/:channelId ──────────────────────────
  fastify.patch('/:channelId', {
    preHandler: adminHandler,
    schema: {
      tags: ['Channels'],
      summary: 'Actualizar canal',
      description: 'Modifica nombre o configuración del canal. **Requiere rol admin.**',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'channelId'],
        properties: {
          workspaceId: { type: 'string' },
          channelId:   { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name:   { type: 'string' },
          config: { type: 'object' },
          design: {
            type: 'object',
            properties: {
              primary_color:            { type: 'string', nullable: true },
              text_color:               { type: 'string', nullable: true },
              position:                 { type: 'string', enum: ['bottom-right', 'bottom-left'], nullable: true },
              launcher_size:            { type: 'string', enum: ['small', 'medium', 'large'], nullable: true },
              bot_avatar_url:           { type: 'string', nullable: true },
              bot_display_name:         { type: 'string', nullable: true },
              bot_subtitle:             { type: 'string', nullable: true },
              welcome_message:          { type: 'string', nullable: true },
              show_unread_badge:        { type: 'boolean', nullable: true },
              launcher_icon:            { type: 'string', nullable: true },
              custom_launcher_icon_url: { type: 'string', nullable: true },
              font_family:              { type: 'string', nullable: true },
              border_radius:            { type: 'string', nullable: true },
            },
          },
        },
      },
      response: {
        200: { description: 'Canal actualizado', ...ChannelObject },
        403: { description: 'Se requiere rol admin', ...errorResponse },
        404: { description: 'Canal no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    const { design, config, ...rest } = request.body
    const updateData = { ...rest }

    // Usar dot-notation para no sobrescribir otras ramas de config
    if (design !== undefined && design !== null) {
      updateData['config.design'] = design
    }
    if (config !== undefined) {
      for (const [key, value] of Object.entries(config)) {
        updateData[`config.${key}`] = value
      }
    }

    return channelService.updateChannel(request.workspaceId, request.params.channelId, updateData)
  })

  // ─── POST /api/:workspaceId/channels/:channelId/toggle ────────────────────
  fastify.post('/:channelId/toggle', {
    preHandler: adminHandler,
    schema: {
      tags: ['Channels'],
      summary: 'Activar / desactivar canal',
      description: 'Cambia el estado `active` del canal sin eliminarlo. **Requiere rol admin.**',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'channelId'],
        properties: {
          workspaceId: { type: 'string' },
          channelId:   { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['active'],
        properties: {
          active: { type: 'boolean', description: 'true = activar, false = desactivar' },
        },
      },
      response: {
        200: { description: 'Estado actualizado', ...ChannelObject },
        403: { description: 'Se requiere rol admin', ...errorResponse },
      },
    },
  }, async (request) => {
    return channelService.toggleChannel(request.workspaceId, request.params.channelId, request.body.active)
  })

  // ─── POST /api/:workspaceId/channels/verify-meta-token ───────────────────
  // Verifica que un Page Access Token de Meta sea válido antes de guardar el canal.
  fastify.post('/verify-meta-token', {
    preHandler: adminHandler,
    schema: {
      tags: ['Channels'],
      summary: 'Verificar Page Access Token de Meta',
      description: 'Llama a la Graph API para comprobar que el token es válido y obtener el nombre de la página. Útil en el wizard de configuración de Facebook Messenger o Instagram DM.',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['access_token'],
        properties: {
          access_token: { type: 'string', description: 'Page Access Token de Meta' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid:     { type: 'boolean' },
            page_name: { type: 'string', nullable: true },
            page_id:   { type: 'string', nullable: true },
            error:     { type: 'string', nullable: true },
          },
        },
      },
    },
  }, async (request) => {
    const { verifyPageToken } = require('../../services/meta.service')
    return verifyPageToken(request.body.access_token)
  })

  // ─── GET /api/:workspaceId/channels/:channelId/widget-script ─────────────
  fastify.get('/:channelId/widget-script', {
    preHandler,
    schema: {
      tags: ['Channels'],
      summary: 'Obtener script del widget web',
      description: 'Retorna el snippet `<script>` listo para pegar en el HTML del sitio del cliente.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'channelId'],
        properties: {
          workspaceId: { type: 'string' },
          channelId:   { type: 'string' },
        },
      },
      response: {
        200: {
          description: 'Script del widget',
          type: 'object',
          properties: {
            script: { type: 'string', description: 'Snippet HTML/JS para incrustar el chat widget' },
          },
        },
        404: { description: 'Canal no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    const workspace = await Workspace.findById(request.workspaceId).lean()
    const script = channelService.getWidgetScript(workspace)
    return { script }
  })

  // ─── POST /:channelId/verify-email ────────────────────────────────────────
  // Verifica las credenciales de salida del canal email (SMTP, SendGrid o Mailgun)
  fastify.post('/:channelId/verify-email', {
    preHandler: adminHandler,
    schema: {
      tags: ['Channels'],
      summary: 'Verificar credenciales del canal email',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'channelId'],
        properties: {
          workspaceId: { type: 'string' },
          channelId:   { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
            error: { type: 'string', nullable: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { channelId } = request.params
    const channel = await channelService.getChannel(request.workspaceId, channelId)

    if (channel.type !== 'email') {
      return reply.code(400).send({ error: 'Este canal no es de tipo email' })
    }

    const {
      verifySmtpCredentials,
      verifySendGridCredentials,
      verifyMailgunCredentials,
    } = require('../../services/email.service')

    const config = channel.config || {}
    const provider = config.outbound_provider || 'smtp'

    let result
    if (provider === 'smtp') {
      result = await verifySmtpCredentials(config)
    } else if (provider === 'sendgrid') {
      result = await verifySendGridCredentials(config.sendgrid_api_key)
    } else if (provider === 'mailgun') {
      result = await verifyMailgunCredentials(config.mailgun_api_key, config.mailgun_domain, config.mailgun_region)
    } else {
      result = { valid: false, error: `Proveedor '${provider}' no soportado` }
    }

    return result
  })
}

module.exports = channelRoutes
