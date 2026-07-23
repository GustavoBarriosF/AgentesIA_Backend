'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const contactSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  name: { type: String, trim: true, default: 'Visitante' },
  email: { type: String, lowercase: true, trim: true, default: null },
  phone: { type: String, trim: true, default: null },
  identification: { type: String, trim: true, default: null },
  avatar_url: { type: String, default: null },
  session_id: { type: String, default: null, index: true },
  channel_ref: { type: String, required: true },
  channel_type: {
    type: String,
    enum: ['web_widget', 'whatsapp', 'whatsapp_baileys', 'telegram', 'api', 'facebook_messenger', 'instagram_dm', 'email', 'slack', 'teams', 'sms', 'line'],
    required: true,
  },
  custom_fields: { type: Schema.Types.Mixed, default: {} },
  conversation_count: { type: Number, default: 0 },
  last_seen: { type: Date, default: Date.now },
  // Código corto de cliente (hasta 8 dígitos numéricos, único por workspace)
  customer_code: { type: Number, default: null },
  // Opt-out global de campañas para este workspace
  campaign_opted_out:    { type: Boolean, default: false },
  campaign_opted_out_at: { type: Date, default: null },
}, { timestamps: true })

contactSchema.index({ workspace_id: 1, channel_ref: 1, channel_type: 1 }, { unique: true })
contactSchema.index({ workspace_id: 1, customer_code: 1 }, { unique: true, sparse: true })
contactSchema.index({ workspace_id: 1, email: 1 })
contactSchema.index({ workspace_id: 1, createdAt: -1 })

module.exports = mongoose.model('Contact', contactSchema)
