'use strict'

const msgService     = require('../../services/message.service')
const storageService = require('../../services/storage.service')
const channelService = require('../../services/channel.service')
const User           = require('../../db/models/user')
const Conversation   = require('../../db/models/conversation')
const Channel        = require('../../db/models/channel')
const Contact        = require('../../db/models/contact')
const PaymentLink    = require('../../db/models/payment-link')
const { errorResponse, security } = require('../../schemas/common')

const AttachmentObject = {
  type: 'object',
  properties: {
    _id:        { type: 'string' },
    filename:   { type: 'string' },
    mime_type:  { type: 'string' },
    size_bytes: { type: 'number', nullable: true },
    url:        { type: 'string' },
    type:       { type: 'string' },
  },
  additionalProperties: false,
}

const MessageObject = {
  type: 'object',
  properties: {
    _id:               { type: 'string' },
    workspace_id:      { type: 'string' },
    conversation_id:   { type: 'string' },
    sender_type:       { type: 'string', enum: ['contact', 'agent', 'bot', 'system'] },
    sender_id:         { type: 'string', nullable: true },
    type:              { type: 'string', enum: ['text', 'image', 'audio', 'video', 'file', 'location', 'template', 'system'] },
    content:           { type: 'string', nullable: true },
    attachments:       { type: 'array', items: AttachmentObject, default: [] },
    channel_message_id:{ type: 'string', nullable: true },
    read_at:           { type: 'string', format: 'date-time', nullable: true },
    createdAt:         { type: 'string', format: 'date-time' },
  },
}

const convParams = {
  type: 'object',
  required: ['workspaceId', 'convId'],
  properties: {
    workspaceId: { type: 'string' },
    convId:      { type: 'string', description: 'ID de la conversación' },
  },
}

async function messageRoutes(fastify) {
  const preHandler = [fastify.authenticate, fastify.requireWorkspace]

  // ─── GET /api/:workspaceId/messages/:convId ───────────────────────────────
  fastify.get('/:convId', {
    preHandler,
    schema: {
      tags: ['Messages'],
      summary: 'Obtener mensajes de una conversación',
      description: 'Retorna mensajes ordenados del más reciente al más antiguo. Usa `before` para paginación hacia atrás (scroll infinito).',
      security,
      params: convParams,
      querystring: {
        type: 'object',
        properties: {
          before: {
            type: 'string',
            description: 'ID del mensaje más antiguo ya cargado — carga mensajes anteriores a este',
          },
          limit: {
            type: 'integer',
            default: 30,
            minimum: 1,
            maximum: 100,
            description: 'Cantidad de mensajes a retornar',
          },
        },
      },
      response: {
        200: {
          description: 'Lista de mensajes',
          type: 'array',
          items: MessageObject,
        },
        404: { description: 'Conversación no encontrada', ...errorResponse },
      },
    },
  }, async (request) => {
    const { before, limit } = request.query
    return msgService.listMessages(request.workspaceId, request.params.convId, { before, limit })
  })

  // ─── POST /api/:workspaceId/messages/:convId ──────────────────────────────
  fastify.post('/:convId', {
    preHandler,
    schema: {
      tags: ['Messages'],
      summary: 'Enviar mensaje de texto',
      description: 'El agente envía un mensaje de texto o template a la conversación. El mensaje se entrega por el canal correspondiente (WhatsApp, Telegram, etc.).',
      security,
      params: convParams,
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1, example: 'Hola, ¿en qué puedo ayudarte?' },
          type: {
            type: 'string',
            enum: ['text', 'template'],
            default: 'text',
            description: '`text` = mensaje libre, `template` = plantilla aprobada de WhatsApp',
          },
        },
      },
      response: {
        200: { description: 'Mensaje enviado', ...MessageObject },
        400: { description: 'Datos inválidos', ...errorResponse },
        404: { description: 'Conversación no encontrada', ...errorResponse },
      },
    },
  }, async (request) => {
    const { message } = await msgService.createMessage({
      workspaceId:    request.workspaceId,
      conversationId: request.params.convId,
      senderType:     'agent',
      senderId:       request.user.sub,
      type:           request.body.type || 'text',
      content:        request.body.content,
    })
    fastify.io?.to(`conv:${request.params.convId}`).emit('new:message', message)
    fastify.widgetIo?.to(`conv:${request.params.convId}`).emit('new:message', message)
    // Notificar al widget el nombre del agente para actualizar el header
    try {
      const user = await User.findById(request.user.sub).select('name').lean()
      if (user?.name) {
        fastify.widgetIo?.to(`conv:${request.params.convId}`).emit('conversation:assigned', { agent_name: user.name })
      }
    } catch {}

    // Entregar al canal externo en background (WhatsApp, Telegram, SMS, LINE, etc.)
    setImmediate(async () => {
      try {
        const conv = await Conversation.findById(request.params.convId).select('channel_id contact_id').lean()
        if (!conv) return
        const channel = await Channel.findById(conv.channel_id).lean()
        if (!channel || channel.type === 'web_widget' || channel.type === 'api') return
        const contact = await Contact.findById(conv.contact_id).select('channel_ref').lean()
        if (!contact?.channel_ref) return
        await channelService.sendToChannel(channel, contact.channel_ref, { content: request.body.content, type: request.body.type || 'text' }, request.params.convId)
      } catch (err) {
        require('../../utils/logger').warn({ err: err.message }, '[Messages] No se pudo entregar al canal externo')
      }
    })

    return message
  })

  // ─── POST /api/:workspaceId/messages/:convId/upload ───────────────────────
  fastify.post('/:convId/upload', {
    preHandler,
    schema: {
      tags: ['Messages'],
      summary: 'Enviar archivo adjunto',
      description: 'Sube un archivo a S3/R2 y lo envía como mensaje en la conversación. **Content-Type: multipart/form-data**. Tamaño máximo: 50MB.',
      security,
      params: convParams,
      consumes: ['multipart/form-data'],
      body: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            format: 'binary',
            description: 'Archivo a enviar (imagen, audio, video, documento)',
          },
        },
      },
      response: {
        200: {
          description: 'Archivo enviado',
          type: 'object',
          properties: {
            message:    MessageObject,
            attachment: {
              type: 'object',
              properties: {
                _id:       { type: 'string' },
                type:      { type: 'string' },
                filename:  { type: 'string' },
                mime_type: { type: 'string' },
                size_bytes:{ type: 'integer' },
                url:       { type: 'string', format: 'uri' },
              },
            },
          },
        },
        400: { description: 'Archivo requerido o formato inválido', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const data = await request.file()
    if (!data) return reply.code(400).send({ error: 'Archivo requerido' })

    const { message, attachment } = await storageService.uploadMessageFile({
      workspaceId:    request.workspaceId,
      conversationId: request.params.convId,
      senderId:       request.user.sub,
      file:           data,
    })

    // Enriquecer con datos del attachment para el socket (el documento crudo solo tiene IDs)
    const msgWithAttachment = {
      ...message.toObject(),
      attachments: [{ _id: attachment._id, filename: attachment.filename, mime_type: attachment.mime_type, size_bytes: attachment.size_bytes, url: attachment.url }],
    }
    fastify.io?.to(`conv:${request.params.convId}`).emit('new:message', msgWithAttachment)
    fastify.io?.to(`workspace:${request.workspaceId}`).emit('new:message', { conversationId: request.params.convId, message: msgWithAttachment })
    fastify.widgetIo?.to(`conv:${request.params.convId}`).emit('new:message', msgWithAttachment)
    return { message: msgWithAttachment, attachment }
  })

  // ─── POST /api/:workspaceId/messages/:convId/read ─────────────────────────
  fastify.post('/:convId/read', {
    preHandler,
    schema: {
      tags: ['Messages'],
      summary: 'Marcar mensajes como leídos',
      description: 'Marca todos los mensajes no leídos de la conversación como leídos. Emite evento WebSocket `messages:read`.',
      security,
      params: convParams,
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
        },
      },
    },
  }, async (request) => {
    await msgService.markAsRead(request.workspaceId, request.params.convId)
    fastify.io?.to(`conv:${request.params.convId}`).emit('messages:read', { convId: request.params.convId })
    return { ok: true }
  })
  // ─── POST /api/:workspaceId/messages/:convId/send-payment-link ───────────
  fastify.post('/:convId/send-payment-link', {
    preHandler,
    schema: {
      tags: ['Messages'],
      summary: 'Enviar link de pago al chat',
      description: 'El agente selecciona un PaymentLink existente y lo envía como mensaje a la conversación.',
      security,
      params: convParams,
      body: {
        type: 'object',
        required: ['payment_link_id'],
        properties: {
          payment_link_id: { type: 'string', description: 'ID del PaymentLink' },
        },
      },
      response: {
        201: {
          description: 'Mensaje enviado',
          type: 'object',
          properties: {
            message: MessageObject,
          },
        },
        404: { description: 'PaymentLink o conversación no encontrada', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { workspaceId } = request
    const { convId } = request.params
    const { payment_link_id } = request.body

    const paymentLink = await PaymentLink.findOne({ _id: payment_link_id, workspace_id: workspaceId }).lean()
    if (!paymentLink) return reply.code(404).send({ error: 'PaymentLink no encontrado' })

    if (paymentLink.conversation_id &&
        paymentLink.conversation_id.toString() !== convId) {
      return reply.code(409).send({
        error: 'Este link de pago ya fue enviado a otra conversación',
      })
    }

    const conversation = await Conversation.findOne({ _id: convId, workspace_id: workspaceId }).lean()
    if (!conversation) return reply.code(404).send({ error: 'Conversación no encontrada' })

    const label = paymentLink.description || 'Link de pago'
    const content = `💳 Link de pago: ${label}\n\n${paymentLink.url}`

    const { message } = await msgService.createMessage({
      workspaceId,
      conversationId: convId,
      senderType: 'agent',
      senderId: request.user.sub,
      type: 'text',
      content,
    })

    await PaymentLink.findByIdAndUpdate(paymentLink._id, {
      $set: { conversation_id: convId, contact_id: conversation.contact_id },
    })

    fastify.io?.to(`conv:${convId}`).emit('new:message', message)
    fastify.io?.to(`workspace:${workspaceId}`).emit('new:message', { conversationId: convId, message })
    fastify.widgetIo?.to(`conv:${convId}`).emit('new:message', message)

    return reply.code(201).send({ message })
  })
}

module.exports = messageRoutes
