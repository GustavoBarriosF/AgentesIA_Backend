'use strict'

const Message = require('../db/models/message')
const Conversation = require('../db/models/conversation')

/**
 * Crea un mensaje y actualiza el timestamp de la conversacion.
 * No hace emit de WebSocket (eso lo hace el llamador con acceso a fastify.io).
 */
async function createMessage({ workspaceId, conversationId, senderType, senderId, type, content, channelMessageId, aiMeta, attachmentIds, emailMessageId, emailInReplyTo, emailSubject }) {
  // Verificar duplicado por channel_message_id
  if (channelMessageId) {
    const exists = await Message.findOne({ workspace_id: workspaceId, conversation_id: conversationId, channel_message_id: channelMessageId })
    if (exists) return { message: exists, isDuplicate: true }
  }

  const message = await Message.create({
    workspace_id: workspaceId,
    conversation_id: conversationId,
    sender_type: senderType,
    sender_id: senderId || null,
    type: type || 'text',
    content,
    channel_message_id: channelMessageId || null,
    attachment_ids: attachmentIds || [],
    ai_meta: aiMeta || {},
    email_message_id: emailMessageId || null,
    email_in_reply_to: emailInReplyTo || null,
    email_subject:    emailSubject    || null,
  })

  // Actualizar conversacion
  const update = { last_message_at: new Date() }
  if (senderType === 'bot') {
    update.$inc = { bot_turns: 1 }
  }
  if (senderType === 'agent' || senderType === 'bot') {
    // Calcular first_response_time si no esta seteado
    const conv = await Conversation.findById(conversationId)
    if (conv && !conv.first_response_time_s) {
      const diffS = Math.floor((Date.now() - conv.createdAt.getTime()) / 1000)
      update.first_response_time_s = diffS
    }
  }

  await Conversation.findByIdAndUpdate(conversationId, update)

  return { message, isDuplicate: false }
}

async function listMessages(workspaceId, conversationId, { before, limit = 50 } = {}) {
  const query = { workspace_id: workspaceId, conversation_id: conversationId }
  if (before) query._id = { $lt: before }

  const messages = await Message.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('attachment_ids')
    .lean()

  return messages.reverse().map(m => ({
    ...m,
    attachments: m.attachment_ids || [],
  }))
}

async function markAsRead(workspaceId, conversationId) {
  await Message.updateMany(
    { workspace_id: workspaceId, conversation_id: conversationId, sender_type: 'contact', read_at: null },
    { $set: { read_at: new Date() } }
  )
}

module.exports = { createMessage, listMessages, markAsRead }
