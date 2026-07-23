'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

/**
 * Registro de cada contacto dentro de una campaña.
 * Una fila por (campaña × contacto).
 * Para campañas drip, una fila por (campaña × contacto × paso).
 */
const campaignContactSchema = new Schema({
  campaign_id:  { type: Schema.Types.ObjectId, ref: 'Campaign',  required: true },
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  contact_id:   { type: Schema.Types.ObjectId, ref: 'Contact',   required: true },

  // Variante A/B: 'a' | 'b' | null (sin A/B test)
  variant: { type: String, enum: ['a', 'b', null], default: null },

  // Paso drip (0 para campañas immediate, 0..N para drip)
  drip_step: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ['pending', 'sent', 'delivered', 'read', 'replied', 'failed', 'opted_out', 'skipped'],
    default: 'pending',
  },

  // Reintentos del job
  attempts:      { type: Number, default: 0 },
  failed_reason: { type: String, default: null },

  // Timestamps de eventos del canal
  sent_at:      { type: Date, default: null },
  delivered_at: { type: Date, default: null },
  read_at:      { type: Date, default: null },
  replied_at:   { type: Date, default: null },

  // ID del mensaje en el canal externo (para tracking de entrega/lectura vía webhook)
  channel_message_id: { type: String, default: null },
}, { timestamps: true })

campaignContactSchema.index({ campaign_id: 1, status: 1 })
campaignContactSchema.index({ campaign_id: 1, contact_id: 1, drip_step: 1 }, { unique: true })
campaignContactSchema.index({ workspace_id: 1, contact_id: 1 }) // para buscar historial por contacto
campaignContactSchema.index({ channel_message_id: 1 })          // para webhooks de entrega

module.exports = mongoose.model('CampaignContact', campaignContactSchema)
