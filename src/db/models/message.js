'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const messageSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  conversation_id: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
  sender_type: { type: String, enum: ['contact', 'agent', 'bot', 'system'], required: true },
  sender_id: { type: Schema.Types.ObjectId, default: null },
  type: {
    type: String,
    enum: ['text', 'image', 'audio', 'video', 'file', 'location', 'template', 'system'],
    default: 'text',
  },
  content: { type: String, default: '' },
  attachment_ids: [{ type: Schema.Types.ObjectId, ref: 'Attachment' }],
  channel_message_id: { type: String, default: null },
  read_at: { type: Date, default: null },
  ai_meta: {
    model: { type: String, default: null },
    input_tokens: { type: Number, default: null },
    output_tokens: { type: Number, default: null },
    confidence: { type: Number, default: null },
    knowledge_item_ids: [{ type: Schema.Types.ObjectId }],
    escalation_reason: { type: String, default: null },
    quick_replies: [{ type: String }],
    bot_id: { type: String, default: null },
    bot_name: { type: String, default: null },
  },
  // Email threading (solo para mensajes de canales de tipo 'email')
  email_message_id: { type: String, default: null }, // Message-ID del correo (para threading)
  email_in_reply_to: { type: String, default: null }, // In-Reply-To header del correo
  email_subject:    { type: String, default: null }, // Asunto del correo
  // Metadatos específicos del canal de entrega (SMS costo, Line userId, etc.)
  channel_meta: { type: Schema.Types.Mixed, default: null },
}, { timestamps: true })

messageSchema.index({ workspace_id: 1, conversation_id: 1, createdAt: 1 })
messageSchema.index({ workspace_id: 1, conversation_id: 1, channel_message_id: 1 })

module.exports = mongoose.model('Message', messageSchema)
