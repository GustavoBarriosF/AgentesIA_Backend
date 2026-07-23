'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const workspaceSchema = new Schema({
  name: { type: String, required: true, trim: true },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: /^[a-z0-9-]+$/,
  },
  branding: {
    logo_url:        { type: String, default: null },
    primary_color:   { type: String, default: '#6366f1' },
    secondary_color: { type: String, default: '#8b5cf6' },
    text_color:      { type: String, default: '#0f172a' },
    icon_color:      { type: String, default: '#6366f1' },
    bot_name:        { type: String, default: 'Asistente' },
  },
  settings: {
    language: { type: String, default: 'es' },
    timezone: { type: String, default: 'America/Argentina/Buenos_Aires' },
    business_hours: {
      enabled: { type: Boolean, default: false },
      schedule: {
        type: Map,
        of: new Schema({
          open: String,
          close: String,
          enabled: Boolean,
        }, { _id: false }),
        default: {},
      },
    },
    auto_assign: { type: Boolean, default: true },
    bot_enabled: { type: Boolean, default: true },
    max_bot_turns: { type: Number, default: 5 },
    // ID del BotAgent que inicia cada conversación nueva (null = sin bot)
    entry_bot_id: { type: Schema.Types.ObjectId, ref: 'BotAgent', default: null },
    csat_enabled: { type: Boolean, default: true },
    bot_messages: {
      // Sin variables de interpolación
      transfer_to_agent:    { type: String, default: null },
      // Sin variables de interpolación
      max_turns_reached:    { type: String, default: null },
      // Sin variables de interpolación
      collect_name_error:   { type: String, default: null },
      // Sin variables de interpolación
      collect_email_error:  { type: String, default: null },
      // Sin variables de interpolación
      collect_phone_error:  { type: String, default: null },
      // Sin variables de interpolación
      collect_id_error:     { type: String, default: null },
      // Variables: {{documento}}
      erp_customer_not_found: { type: String, default: null },
      // Variables: {{ticket}}, {{nombre}}
      ticket_created:       { type: String, default: null },
      // Sin variables de interpolación
      out_of_hours:         { type: String, default: null },
      // Sin variables de interpolación
      no_agents_available:  { type: String, default: null },
    },
  },
  integrations: {
    anthropic_api_key: { type: String, default: null },
  },
  active: { type: Boolean, default: true },
}, { timestamps: true })

module.exports = mongoose.model('Workspace', workspaceSchema)
