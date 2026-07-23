'use strict'

const contactService  = require('./contact.service')
const convService     = require('./conversation.service')
const msgService      = require('./message.service')
const botService      = require('./bot.service')
const routingService  = require('./routing.service')
const campaignService = require('./campaign.service')
const Campaign        = require('../db/models/campaign')
const CampaignContact     = require('../db/models/campaign-contact')
const Workspace       = require('../db/models/workspace')
const Conversation    = require('../db/models/conversation')
const Message         = require('../db/models/message')
const logger          = require('../utils/logger')
const { getRedis }    = require('../db/redis')

/**
 * Punto de entrada central para mensajes entrantes de cualquier canal.
 * Crea/actualiza contacto, conversación y mensaje, luego enruta a bot o agente.
 *
 * @param {object} fastify   - Instancia de Fastify (necesaria para io, checkLimit, incrementConversation)
 * @param {object} params
 * @param {string} params.workspaceId
 * @param {string} params.channelId
 * @param {string} params.channelRef   - Identificador único del remitente en el canal (teléfono, chatId, etc.)
 * @param {string} params.channelType  - Tipo de canal ('whatsapp', 'telegram', 'whatsapp_baileys', etc.)
 * @param {string} params.name         - Nombre del remitente
 * @param {string} params.text         - Texto del mensaje
 * @param {string} [params.channelMessageId] - ID único del mensaje en el canal (para deduplicación)
 * @param {object} [params.metadata]   - Metadata adicional del canal
 */
async function processIncomingMessage(fastify, { workspaceId, channelId, channelRef, channelType, name, text, channelMessageId, metadata }) {
  // Paso 1: Identificar o crear contacto
  const contact = await contactService.findOrCreateContact(workspaceId, {
    channelRef,
    channelType,
    name,
  })

  // Paso 2: Buscar o crear conversación activa
  let isNew = false
  let conversation = null

  // Para email: intentar reanudar el hilo por In-Reply-To antes de la búsqueda estándar
  if (channelType === 'email' && metadata?.email_in_reply_to) {
    const threadMsg = await Message.findOne({
      workspace_id:     workspaceId,
      email_message_id: metadata.email_in_reply_to,
    }).lean()

    if (threadMsg) {
      const threadConv = await Conversation.findOne({
        _id:          threadMsg.conversation_id,
        workspace_id: workspaceId,
        status:       { $nin: ['abandoned'] },
      }).lean()

      if (threadConv) {
        conversation = threadConv
        isNew = false
      }
    }
  }

  if (!conversation) conversation = await Conversation.findOne({
    workspace_id: workspaceId,
    contact_id:   contact._id,
    channel_id:   channelId,
    status:       { $nin: ['resolved', 'abandoned'] },
  })

  if (!conversation) {
    const lockKey = `conv:lock:${workspaceId}:${String(contact._id)}:${channelId}`
    let lockAcquired = false
    try {
      let acquired
      try {
        acquired = await getRedis().set(lockKey, '1', 'NX', 'EX', 10)
      } catch (redisErr) {
        logger.error({ err: redisErr }, 'Redis lock error — continuando sin lock')
        acquired = 'OK' // fallback: continuar sin lock
      }

      if (acquired === null) {
        // Otro proceso está creando la conversación — reintentar hasta 3 veces con 300ms entre cada intento
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 300))
          conversation = await Conversation.findOne({
            workspace_id: workspaceId,
            contact_id:   contact._id,
            channel_id:   channelId,
            status:       { $nin: ['resolved', 'abandoned'] },
          })
          if (conversation) break // Encontrada — salir del bucle

          // No encontrada — intentar adquirir el lock
          let retryAcquired
          try {
            retryAcquired = await getRedis().set(lockKey, '1', 'NX', 'EX', 10)
          } catch (redisErr) {
            logger.error({ err: redisErr }, 'Redis lock error en reintento — continuando sin lock')
            retryAcquired = 'OK'
          }
          if (retryAcquired !== null) {
            lockAcquired = true
            break // Tenemos el lock — salir para crear la conversación
          }
        }
        // Si tras 3 intentos no hay conversación ni lock, continuar sin lock (degraded)
      } else {
        lockAcquired = true
      }

      if (!conversation) {
        // Tenemos el lock (o fallback sin lock) — crear la conversación
        await fastify.checkLimit(workspaceId, 'conversation')
        conversation = await convService.createConversation(workspaceId, {
          contactId: contact._id,
          channelId,
          metadata,
        })
        await fastify.incrementConversation(workspaceId)
        isNew = true
      }
    } finally {
      if (lockAcquired) {
        try {
          await getRedis().del(lockKey)
        } catch (redisErr) {
          logger.error({ err: redisErr }, 'Error al liberar Redis lock')
        }
      }
    }
  }

  // Paso 3: Guardar mensaje del contacto
  const { message, isDuplicate } = await msgService.createMessage({
    workspaceId,
    conversationId:   conversation._id,
    senderType:       'contact',
    type:             'text',
    content:          text,
    channelMessageId,
    emailMessageId:   metadata?.email_message_id  || null,
    emailInReplyTo:   metadata?.email_in_reply_to  || null,
    emailSubject:     metadata?.subject            || null,
  })
  if (isDuplicate) return

  // Emitir evento WebSocket al dashboard (incluye el mensaje completo para actualizar el cache)
  fastify.io?.to(`workspace:${workspaceId}`).emit('new:message', {
    conversationId: conversation._id,
    workspaceId,
    message,
  })

  // Paso 3.5: Detectar si es respuesta a campaña
  let campaignMatch = null
  let campaignRouteToAgent = false
  let campaignRouteToQueue = false
  let campaignDepartmentId = null

  try {
    campaignMatch = await campaignService.checkCampaignReply(workspaceId, contact._id)
    if (campaignMatch) {
      // Opt-out check
      if (campaignService.isOptOutMessage(text)) {
        await campaignService.handleOptOut(workspaceId, contact._id)
        return
      }
      // Marcar como replied en la campaña más reciente
      await CampaignContact.findOneAndUpdate(
        { workspace_id: workspaceId, contact_id: contact._id, status: { $in: ['sent', 'delivered', 'read'] } },
        { status: 'replied', replied_at: new Date() },
        { sort: { sent_at: -1 } }
      )
      await Campaign.findByIdAndUpdate(campaignMatch._id, { $inc: { 'stats.replied': 1 } })

      if (campaignMatch.reply_behavior?.create_conversation !== false) {
        await Conversation.findByIdAndUpdate(conversation._id, { campaign_id: campaignMatch._id })
        // Solo incrementar si la conversación es nueva (isNew === true)
        if (isNew) {
          await Campaign.findByIdAndUpdate(campaignMatch._id, { $inc: { 'stats.conversations_created': 1 } })
        }
      }
      if (campaignMatch.reply_behavior?.route_to === 'agent') {
        campaignRouteToAgent = true
        campaignDepartmentId = campaignMatch.reply_behavior?.assigned_department_id || null
      }
      if (campaignMatch.reply_behavior?.route_to === 'queue') {
        campaignRouteToQueue = true
      }
    }
  } catch (err) {
    logger.warn({ err: err.message, workspaceId }, '[Campaign] Error verificando respuesta de campaña, continuando sin attributión')
    // continuar el flujo normal sin atribución de campaña
  }

  // Paso 4: Verificar workspace activo
  const workspace = await Workspace.findById(workspaceId).lean()
  if (!workspace?.active) return

  // Si ya hay agente asignado, no intervenir
  if (conversation.status === 'assigned') return

  const io = fastify.io

  // Paso 5a: Conversación nueva → iniciar flujo de bot
  if (isNew) {
    // Si la campaña indica enrutar directo a agente, saltar el bot
    if (campaignRouteToAgent) {
      await convService.escalateToQueue(workspaceId, conversation._id, {
        assignedDepartmentId: campaignDepartmentId,
      })
      io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
      return
    }
    if (campaignRouteToQueue) {
      await convService.escalateToQueue(workspaceId, conversation._id)
      io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
      return
    }

    const botStart = await botService.startBotFlow({ workspaceId, conversation, io })
    if (!botStart.handled) {
      // Verificar si la razón es fuera de horario para enviar mensaje configurable
      const routingResult = await routingService.decideHandler(workspace, conversation)
      if (routingResult.reason === 'out_of_hours') {
        const { getBotMessage } = require('./i18n.service')
        const msg = await getBotMessage(workspaceId, 'out_of_hours')
        if (msg) {
          await msgService.createMessage({
            workspaceId,
            conversationId: conversation._id,
            senderType: 'bot',
            type: 'text',
            content: msg,
          })
        }
      }
      await convService.escalateToQueue(workspaceId, conversation._id)
      io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
    } else if (botStart.shouldEscalate) {
      await convService.escalateToQueue(workspaceId, conversation._id, {
        assignedMemberId:     botStart.assignedMemberId,
        assignedDepartmentId: botStart.assignedDepartmentId,
      })
      io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
    }
    return
  }

  // Paso 5b: Conversación en modo bot → procesar respuesta
  if (conversation.status === 'bot') {
    // Si la campaña indica enrutar directo a agente, escalar sin pasar por el bot
    if (campaignRouteToAgent) {
      await convService.escalateToQueue(workspaceId, conversation._id, {
        assignedDepartmentId: campaignDepartmentId,
      })
      io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
      return
    }
    if (campaignRouteToQueue) {
      await convService.escalateToQueue(workspaceId, conversation._id)
      io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
      return
    }

    const { shouldEscalate, resolved, assignedMemberId, assignedDepartmentId } = await botService.handleMessage({
      workspaceId,
      conversation,
      userMessage: text,
      io,
    })

    if (resolved) {
      io?.to(`workspace:${workspaceId}`).emit('conversation:resolved', { id: conversation._id })
      return
    }

    if (shouldEscalate) {
      await convService.escalateToQueue(workspaceId, conversation._id, { assignedMemberId, assignedDepartmentId })
      io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
    }
    return
  }

  // Paso 5c: Conversación en pending/open → enviar a cola
  // Si la campaña indica enrutar directo a agente, escalar inmediatamente
  if (campaignRouteToAgent) {
    await convService.escalateToQueue(workspaceId, conversation._id, {
      assignedDepartmentId: campaignDepartmentId,
    })
    io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
    return
  }
  if (campaignRouteToQueue) {
    await convService.escalateToQueue(workspaceId, conversation._id)
    io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
    return
  }

  const { handler } = await routingService.decideHandler(workspace, conversation)
  if (handler !== 'bot') {
    // Verificar si hay agentes online para enviar mensaje configurable
    const agentsOnline = await getRedis().scard(`agents:online:${workspaceId}`)
    if (agentsOnline === 0) {
      const { getBotMessage } = require('./i18n.service')
      const msg = await getBotMessage(workspaceId, 'no_agents_available')
      if (msg) {
        await msgService.createMessage({
          workspaceId,
          conversationId: conversation._id,
          senderType: 'bot',
          type: 'text',
          content: msg,
        })
      }
    }
    await convService.escalateToQueue(workspaceId, conversation._id)
    io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
  }
}

module.exports = { processIncomingMessage }
