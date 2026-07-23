'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const VALID_TRANSITIONS = {
  open: ['bot', 'pending', 'assigned'],
  bot: ['pending', 'resolved', 'abandoned'],
  pending: ['assigned', 'bot', 'abandoned'],
  assigned: ['resolved', 'pending', 'bot'],
  resolved: ['open'],
  abandoned: ['open'],
}

const conversationSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  contact_id: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
  channel_id: { type: Schema.Types.ObjectId, ref: 'Channel', required: true },
  agent_id:      { type: Schema.Types.ObjectId, ref: 'Agent',      default: null },
  department_id: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
  // ── Estado del bot activo ─────────────────────────────────────────────────
  // ID del BotAgent que está manejando la conversación actualmente
  current_bot_id: { type: Schema.Types.ObjectId, ref: 'BotAgent', default: null },
  // Para decision_bot: índice del paso actual del flujo
  current_step_index: { type: Number, default: 0 },
  // Turns del agente de IA actual (se resetea al cambiar de agente)
  current_agent_turns: { type: Number, default: 0 },
  // Cuando el bot está esperando un dato del contacto
  awaiting_collect: {
    field:           { type: String, enum: ['name', 'email', 'phone', 'identification', 'text'], default: null },
    collect_key:     { type: String, default: null }, // clave para guardar texto libre en bot_collected_data
    error_message:   { type: String, default: null },
    next_step_index: { type: Number, default: null },
  },
  // Respuestas de texto libre recolectadas por el bot (clave → valor)
  bot_collected_data: { type: Map, of: String, default: {} },
  // IDs de bots ya visitados en esta conversación (para detectar loops de route_bot)
  visited_bot_ids: [{ type: Schema.Types.ObjectId, ref: 'BotAgent' }],
  // Contexto ERP activo durante el flujo de bot (cliente identificado en el ERP)
  erp_context: {
    identifier:    { type: String, default: null }, // cédula / NIT / email que ingresó
    customer_id:   { type: String, default: null }, // ID del cliente en el ERP
    customer_name: { type: String, default: null },
  },
  status: {
    type: String,
    enum: ['open', 'bot', 'pending', 'assigned', 'resolved', 'abandoned'],
    default: 'open',
  },
  handled_by: { type: String, enum: ['bot', 'agent', 'hybrid', null], default: null },
  bot_turns: { type: Number, default: 0 },
  first_response_time_s: { type: Number, default: null },
  resolution_time_s: { type: Number, default: null },
  resolved_at: { type: Date, default: null },
  csat_score: { type: Number, min: 1, max: 5, default: null },
  csat_comment: { type: String, default: null },
  tags: [{ type: String, trim: true }],
  metadata: {
    page_url: { type: String, default: null },
    utm_source: { type: String, default: null },
    utm_medium: { type: String, default: null },
    utm_campaign: { type: String, default: null },
    user_agent: { type: String, default: null },
    ip: { type: String, default: null },
  },
  last_message_at: { type: Date, default: Date.now },
  // ── Estado del protocolo activo (solo para ai_agent con protocol_id) ──────────
  active_protocol_id:   { type: Schema.Types.ObjectId, ref: 'KnowledgeItem', default: null },
  active_protocol_step: { type: Number, default: 1 },      // paso actual (empieza en 1)
  protocol_step_turns:  { type: Number, default: 0 },      // turnos usados en el paso actual
  protocol_completed:   { type: Boolean, default: false },  // true cuando terminó todos los pasos
  // Campaña que originó esta conversación (null = conversación orgánica)
  campaign_id: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null },
}, { timestamps: true })

// Validacion de transiciones de estado
conversationSchema.pre('save', function(next) {
  if (this.isModified('status') && !this.isNew) {
    const prev = this._previousStatus
    if (prev && VALID_TRANSITIONS[prev] && !VALID_TRANSITIONS[prev].includes(this.status)) {
      return next(new Error(`Transicion de estado invalida: ${prev} -> ${this.status}`))
    }
  }
  next()
})

conversationSchema.index({ workspace_id: 1, status: 1, createdAt: -1 })
conversationSchema.index({ workspace_id: 1, contact_id: 1, status: 1 })
conversationSchema.index({ workspace_id: 1, agent_id: 1, status: 1 })
conversationSchema.index({ workspace_id: 1, channel_id: 1 })
conversationSchema.index({ workspace_id: 1, last_message_at: -1 })
conversationSchema.index({ workspace_id: 1, campaign_id: 1 })

module.exports = mongoose.model('Conversation', conversationSchema)
