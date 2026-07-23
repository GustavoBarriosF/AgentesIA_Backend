'use strict'

const Channel      = require('../../db/models/channel')
const Workspace    = require('../../db/models/workspace')
const Contact      = require('../../db/models/contact')
const Conversation = require('../../db/models/conversation')
const Message      = require('../../db/models/message')
const Attachment   = require('../../db/models/attachment')
const convService  = require('../../services/conversation.service')
const msgService   = require('../../services/message.service')
const botService   = require('../../services/bot.service')
const storageService = require('../../services/storage.service')
const logger       = require('../../utils/logger')

function toBool(val) {
  return val === true || val === 'true'
}

async function widgetRoutes(fastify) {

  // ── GET /widget/config/:slug ────────────────────────────────────────────
  // Llamado al inicializar el widget. Devuelve configuración del workspace.
  fastify.get('/config/:slug', {
    schema: {
      tags: ['Widget'],
      summary: 'Configuración del widget por slug',
      params: { type: 'object', required: ['slug'], properties: { slug: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            workspace_id:    { type: 'string' },
            workspace_name:  { type: 'string' },
            channel_id:      { type: 'string' },
            bot_name:        { type: 'string' },
            primary_color:   { type: 'string' },
            logo_url:        { type: 'string', nullable: true },
            welcome_message: { type: 'string' },
            placeholder:     { type: 'string' },
            bot_enabled:     { type: 'boolean' },
            position:        { type: 'string' },
            design: {
              type: 'object',
              properties: {
                primary_color:            { type: 'string' },
                text_color:               { type: 'string' },
                position:                 { type: 'string' },
                launcher_size:            { type: 'string' },
                bot_avatar_url:           { type: 'string', nullable: true },
                bot_display_name:         { type: 'string', nullable: true },
                bot_subtitle:             { type: 'string', nullable: true },
                welcome_message:          { type: 'string', nullable: true },
                show_unread_badge:        { type: 'boolean' },
                launcher_icon:            { type: 'string' },
                custom_launcher_icon_url: { type: 'string', nullable: true },
                font_family:              { type: 'string' },
                border_radius:            { type: 'string' },
              },
            },
            pre_chat_form: {
              type: 'object',
              properties: {
                enabled:                { type: 'boolean' },
                collect_phone:          { type: 'boolean' },
                collect_email:          { type: 'boolean' },
                collect_identification: { type: 'boolean' },
              },
            },
          },
        },
        404: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  }, async (request, reply) => {
    const { slug } = request.params

    const workspace = await Workspace.findOne({ slug, active: true }).lean()
    if (!workspace) return reply.code(404).send({ error: 'Workspace no encontrado' })

    // Buscar canal web_widget activo
    const channel = await Channel.findOne({
      workspace_id: workspace._id,
      type: 'web_widget',
      active: true,
    }).lean()
    if (!channel) return reply.code(404).send({ error: 'Widget no configurado para este workspace' })

    return {
      workspace_id:    workspace._id.toString(),
      workspace_name:  workspace.name,
      channel_id:      channel._id.toString(),
      bot_name:        workspace.branding?.bot_name || 'Asistente',
      primary_color:   channel.config?.color || workspace.branding?.primary_color || '#4F46E5',
      logo_url:        workspace.branding?.logo_url || null,
      welcome_message: channel.config?.welcome_message || null,
      placeholder:     channel.config?.placeholder || 'Escribe tu mensaje...',
      bot_enabled:     workspace.settings?.bot_enabled ?? true,
      position:        channel.config?.position || 'right',
      design: {
        primary_color:            channel.config?.design?.primary_color            ?? '#6366f1',
        text_color:               channel.config?.design?.text_color               ?? '#ffffff',
        position:                 channel.config?.design?.position                 ?? 'bottom-right',
        launcher_size:            channel.config?.design?.launcher_size            ?? 'medium',
        bot_avatar_url:           channel.config?.design?.bot_avatar_url           ?? null,
        bot_display_name:         channel.config?.design?.bot_display_name         ?? null,
        bot_subtitle:             channel.config?.design?.bot_subtitle             ?? null,
        welcome_message:          channel.config?.design?.welcome_message          ?? null,
        show_unread_badge:        channel.config?.design?.show_unread_badge        ?? true,
        launcher_icon:            channel.config?.design?.launcher_icon            ?? 'chat',
        custom_launcher_icon_url: channel.config?.design?.custom_launcher_icon_url ?? null,
        font_family:              channel.config?.design?.font_family              ?? 'system',
        border_radius:            channel.config?.design?.border_radius            ?? 'medium',
      },
      pre_chat_form: {
        enabled:                toBool(channel.config?.pre_chat_form_enabled),
        collect_phone:          toBool(channel.config?.collect_phone),
        collect_email:          toBool(channel.config?.collect_email),
        collect_identification: toBool(channel.config?.collect_identification),
      },
    }
  })

  // ── POST /widget/conversations ──────────────────────────────────────────
  // Crea conversación cuando el visitante envía el primer mensaje.
  fastify.post('/conversations', {
    schema: {
      tags: ['Widget'],
      summary: 'Crear conversación desde widget',
      body: {
        type: 'object',
        required: ['workspace_id', 'channel_id', 'session_id'],
        properties: {
          workspace_id: { type: 'string' },
          channel_id:   { type: 'string' },
          session_id:   { type: 'string' },
          metadata:     { type: 'object', additionalProperties: true },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            conversation_id: { type: 'string' },
            contact_id:      { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { workspace_id, channel_id, session_id, metadata = {} } = request.body

    // Verificar límite de conversaciones del plan
    await fastify.checkLimit(workspace_id, 'conversation')

    // Buscar o crear contacto por session_id (usando channel_ref = session_id para web_widget)
    let contact = await Contact.findOne({
      workspace_id,
      channel_ref: session_id,
      channel_type: 'web_widget',
    }).lean()

    if (!contact) {
      contact = await Contact.create({
        workspace_id,
        session_id,
        channel_ref:     session_id,
        channel_type:    'web_widget',
        name:            metadata.name || 'Visitante',
        email:           metadata.email || null,
        phone:           metadata.phone || null,
        identification:  metadata.identification || null,
        custom_fields:   metadata.custom_fields || {},
      })
      contact = contact.toObject()
    }

    // Buscar conversación abierta previa para este contacto
    let conversation = await Conversation.findOne({
      workspace_id,
      contact_id: contact._id,
      status: { $in: ['open', 'bot'] },
    }).lean()

    if (!conversation) {
      conversation = await Conversation.create({
        workspace_id,
        channel_id,
        contact_id:  contact._id,
        status:      'bot',
        handled_by:  'bot',
        source:      'web_widget',
      })
      conversation = conversation.toObject()

      // Incrementar contador de conversaciones del mes
      await fastify.incrementConversation(workspace_id)

      // Notificar al dashboard que hay una nueva conversación del widget
      const io = fastify.io
      if (io) {
        io.to(`workspace:${workspace_id}`).emit('conversation:pending', {
          id:         conversation._id.toString(),
          source:     'web_widget',
          contact_id: contact._id.toString(),
        })
      }

      // Iniciar flujo del bot si está configurado
      try {
        const botStart = await botService.startBotFlow({ workspaceId: workspace_id, conversation, io: fastify.widgetIo })
        if (botStart.handled && botStart.shouldEscalate) {
          await convService.escalateToQueue(workspace_id, conversation._id, {
            assignedMemberId:     botStart.assignedMemberId,
            assignedDepartmentId: botStart.assignedDepartmentId,
          })
        } else if (!botStart.handled) {
          await convService.escalateToQueue(workspace_id, conversation._id)
        }
      } catch (err) {
        logger.warn({ err }, 'No se pudo iniciar bot flow')
      }
    }

    return reply.code(201).send({
      conversation_id: conversation._id.toString(),
      contact_id:      contact._id.toString(),
    })
  })

  // ── GET /widget/conversations/:convId/messages ──────────────────────────
  // Carga historial de mensajes (los últimos 50, con soporte de cursor).
  fastify.get('/conversations/:convId/messages', {
    schema: {
      tags: ['Widget'],
      summary: 'Historial de mensajes del widget',
      params: { type: 'object', required: ['convId'], properties: { convId: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          before:     { type: 'string', description: 'cursor (message _id) para paginación hacia atrás' },
          limit:      { type: 'number', default: 50 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            messages:    { type: 'array', items: { type: 'object', additionalProperties: true } },
            next_cursor: { type: 'string', nullable: true },
          },
        },
      },
    },
  }, async (request) => {
    const { convId } = request.params
    const { before, limit = 50 } = request.query

    const query = { conversation_id: convId }
    if (before) query._id = { $lt: before }

    const rawMessages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit) + 1)
      .populate('attachment_ids')
      .lean()

    rawMessages.reverse()

    const hasMore = rawMessages.length > limit
    if (hasMore) rawMessages.shift()

    const messages = rawMessages.map(m => ({
      ...m,
      attachments: m.attachment_ids || [],
    }))

    return {
      messages,
      next_cursor: hasMore ? messages[0]._id.toString() : null,
    }
  })

  // ── POST /widget/messages ───────────────────────────────────────────────
  // Enviar mensaje de texto desde el widget.
  fastify.post('/messages', {
    schema: {
      tags: ['Widget'],
      summary: 'Enviar mensaje de texto desde widget',
      body: {
        type: 'object',
        required: ['conversation_id', 'session_id', 'content'],
        properties: {
          conversation_id: { type: 'string' },
          session_id:      { type: 'string' },
          content:         { type: 'string' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            message_id: { type: 'string' },
            created_at: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { conversation_id, session_id, content } = request.body

    const conversation = await Conversation.findById(conversation_id).lean()
    if (!conversation) return reply.code(404).send({ error: 'Conversación no encontrada' })

    const { message } = await msgService.createMessage({
      workspaceId:    conversation.workspace_id.toString(),
      conversationId: conversation_id,
      senderType:     'contact',
      type:           'text',
      content,
    })

    // Emitir al dashboard y al widget via Socket.IO
    const io = fastify.io
    const widgetIo = fastify.widgetIo
    if (io) {
      // Para el agente en el dashboard
      io.to(`conv:${conversation_id}`).emit('new:message', message)
      io.to(`workspace:${conversation.workspace_id}`).emit('new:message', { conversationId: conversation_id, message })
    }
    if (widgetIo) {
      // Para el visitante en el widget
      widgetIo.to(`conv:${conversation_id}`).emit('new:message', message)
    }

    // Responder al widget inmediatamente — el bot procesa en segundo plano
    // y envía su respuesta vía WebSocket. Así el fetch del widget no queda
    // colgado durante el procesamiento (que puede tardar varios segundos).
    reply.code(201).send({
      message_id: message._id.toString(),
      created_at: message.createdAt,
    })

    // Si la conversación está en modo bot, procesarlo en background
    if (conversation.status === 'bot') {
      setImmediate(async () => {
        try {
          const result = await botService.handleMessage({
            workspaceId:  conversation.workspace_id.toString(),
            conversation,
            userMessage:  content,
            io:           widgetIo,
            dashboardIo:  io,
          })
          if (result?.contactUpdated) {
            const wsId = conversation.workspace_id.toString()
            logger.info({ workspaceId: wsId, conversationId: conversation_id }, '[Route] Emitiendo conversation:updated al dashboard')
            io?.to(`workspace:${wsId}`).emit('conversation:updated', {
              id: conversation_id,
            })
          }
          if (result?.shouldEscalate) {
            const wsId = conversation.workspace_id.toString()
            await convService.escalateToQueue(wsId, conversation_id, {
              assignedMemberId:     result.assignedMemberId     ?? null,
              assignedDepartmentId: result.assignedDepartmentId ?? null,
            })
            io?.to(`workspace:${wsId}`).emit('conversation:pending', { id: conversation_id })
          }
          if (result?.resolved) {
            if (widgetIo) {
              widgetIo.to(`conv:${conversation_id}`).emit('conversation:resolved', { conversation_id })
            }
            if (io) {
              io.to(`workspace:${conversation.workspace_id}`).emit('conversation:resolved', { id: conversation_id })
            }
          }
        } catch (err) {
          logger.warn({ err }, 'Error procesando bot response')
        }
      })
    }
  })

  // ── POST /widget/survey ─────────────────────────────────────────────────
  // Guarda encuesta CSAT enviada desde el widget (sin autenticación).
  fastify.post('/survey', {
    schema: {
      tags: ['Widget'],
      summary: 'Guardar encuesta de satisfacción desde widget',
      body: {
        type: 'object',
        required: ['conversation_id', 'session_id', 'score'],
        properties: {
          conversation_id: { type: 'string' },
          session_id:      { type: 'string' },
          score:           { type: 'integer', minimum: 1, maximum: 5 },
          comment:         { type: 'string', maxLength: 500, nullable: true },
        },
      },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
  }, async (request, reply) => {
    const { conversation_id, score, comment } = request.body
    const conv = await Conversation.findById(conversation_id).lean()
    if (!conv) return reply.code(404).send({ error: 'Conversación no encontrada' })
    await Conversation.findByIdAndUpdate(conversation_id, {
      $set: { csat_score: score, csat_comment: comment || null },
    })
    return { ok: true }
  })

  // ── POST /widget/messages/upload ────────────────────────────────────────
  // Subir archivo, imagen o nota de voz desde widget (multipart).
  fastify.post('/messages/upload', {
    schema: {
      tags: ['Widget'],
      summary: 'Subir archivo/imagen/audio desde widget',
      consumes: ['multipart/form-data'],
    },
  }, async (request, reply) => {
    const parts = request.parts()
    let fileBuffer    = null
    let fileName      = ''
    let mimeType      = ''
    let conversationId = ''
    let sessionId     = ''

    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer()
        fileName   = part.filename
        mimeType   = part.mimetype
      } else if (part.fieldname === 'conversation_id') {
        conversationId = part.value
      } else if (part.fieldname === 'session_id') {
        sessionId = part.value
      }
    }

    if (!fileBuffer || !conversationId) {
      return reply.code(400).send({ error: 'Faltan datos requeridos' })
    }

    const conversation = await Conversation.findById(conversationId).lean()
    if (!conversation) return reply.code(404).send({ error: 'Conversación no encontrada' })

    const isImage = mimeType.startsWith('image/')
    const isAudio = mimeType.startsWith('audio/')
    const attachmentType = isImage ? 'image' : isAudio ? 'audio' : 'document'
    const msgType = isImage ? 'image' : isAudio ? 'audio' : 'file'
    const workspaceId = conversation.workspace_id.toString()

    // Subir a R2/S3
    const { key, url } = await storageService.uploadFile({
      workspaceId,
      buffer: fileBuffer,
      filename: fileName,
      mimetype: mimeType,
    })

    const { message } = await msgService.createMessage({
      workspaceId,
      conversationId,
      senderType:    'contact',
      type:          msgType,
      content:       fileName,
    })

    const attachment = await Attachment.create({
      workspace_id: conversation.workspace_id,
      message_id:   message._id,
      type:         attachmentType,
      filename:     fileName,
      mime_type:    mimeType,
      size_bytes:   fileBuffer.length,
      url,
      s3_key:       key,
    })

    message.attachment_ids = [attachment._id]
    await message.save()

    // Emitir con datos del attachment incluidos
    const msgWithAttachment = {
      ...message.toObject(),
      attachments: [{ _id: attachment._id, filename: attachment.filename, mime_type: attachment.mime_type, size_bytes: attachment.size_bytes, url: attachment.url }],
    }

    const io = fastify.io
    const widgetIo = fastify.widgetIo
    if (io) {
      io.to(`conv:${conversationId}`).emit('new:message', msgWithAttachment)
      io.to(`workspace:${conversation.workspace_id}`).emit('new:message', { conversationId, message: msgWithAttachment })
    }
    if (widgetIo) {
      widgetIo.to(`conv:${conversationId}`).emit('new:message', msgWithAttachment)
    }

    return reply.code(201).send({
      message_id:  message._id.toString(),
      url,
      filename:    fileName,
      mimetype:    mimeType,
      size:        fileBuffer.length,
      created_at:  message.createdAt,
    })
  })

  // ── PATCH /widget/contacts/:sessionId ──────────────────────────────────
  // Lead detector: actualiza datos del contacto (email, phone, name).
  fastify.patch('/contacts/:sessionId', {
    schema: {
      tags: ['Widget'],
      summary: 'Actualizar datos del contacto (lead detector)',
      params: { type: 'object', required: ['sessionId'], properties: { sessionId: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          workspace_id:   { type: 'string' },
          name:           { type: 'string', nullable: true },
          email:          { type: 'string', nullable: true },
          phone:          { type: 'string', nullable: true },
          identification: { type: 'string', nullable: true },
        },
      },
      response: { 200: { type: 'object', properties: { updated: { type: 'boolean' } } } },
    },
  }, async (request) => {
    const { sessionId } = request.params
    const { workspace_id, name, email, phone, identification } = request.body

    const update = {}
    if (name)           update.name           = name
    if (email)          update.email          = email
    if (phone)          update.phone          = phone
    if (identification) update.identification = identification

    if (Object.keys(update).length === 0) return { updated: false }

    const contact = await Contact.findOneAndUpdate(
      { channel_ref: sessionId, channel_type: 'web_widget', workspace_id },
      { $set: update },
      { new: true }
    ).lean()

    // Emitir al dashboard para actualización en tiempo real
    if (contact && fastify.io) {
      fastify.io.to(`workspace:${workspace_id}`).emit('contact:updated', {
        contactId: contact._id.toString(),
        ...update,
      })
    }

    return { updated: !!contact }
  })

  // ── POST /widget/messages/read ──────────────────────────────────────────
  // Marca mensajes como leídos cuando el visitante abre el panel.
  fastify.post('/messages/read', {
    schema: {
      tags: ['Widget'],
      summary: 'Marcar mensajes como leídos',
      body: {
        type: 'object',
        required: ['conversation_id'],
        properties: {
          conversation_id: { type: 'string' },
          session_id:      { type: 'string' },
        },
      },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
  }, async (request) => {
    const { conversation_id } = request.body
    await Message.updateMany(
      { conversation_id, sender_type: { $in: ['bot', 'agent'] }, read_at: null },
      { $set: { read_at: new Date() } }
    )
    return { ok: true }
  })
}

module.exports = widgetRoutes
