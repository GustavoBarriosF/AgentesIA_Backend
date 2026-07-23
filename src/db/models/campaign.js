'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const audienceSchema = new Schema({
  type: { type: String, enum: ['all', 'segment', 'manual'], default: 'all' },
  // Filtros para type = 'segment'
  filters: {
    channel_type: { type: String, default: null }, // 'whatsapp' | 'email' | ...
    tags:         [{ type: String }],
    has_phone:    { type: Boolean, default: null },
    has_email:    { type: Boolean, default: null },
    created_after:  { type: Date, default: null },
    created_before: { type: Date, default: null },
  },
  // IDs explícitos para type = 'manual'
  contact_ids: [{ type: Schema.Types.ObjectId, ref: 'Contact' }],
  // Calculado al lanzar
  total_count: { type: Number, default: 0 },
}, { _id: false })

const templateSchema = new Schema({
  type: { type: String, enum: ['text', 'hsm'], default: 'text' },
  // Mensaje de texto libre (con variables {{nombre}}, {{empresa}})
  content: { type: String, default: '' },
  // WhatsApp Business HSM (plantilla aprobada por Meta)
  hsm_name:       { type: String, default: null },
  hsm_language:   { type: String, default: 'es_CO' },
  hsm_components: { type: Schema.Types.Mixed, default: null }, // array de componentes Meta
  // Solo para email
  subject: { type: String, default: null },
  // A/B testing: versión B
  content_b:        { type: String, default: null },
  ab_test_enabled:  { type: Boolean, default: false },
  ab_split_percent: { type: Number, default: 50, min: 10, max: 90 }, // % que recibe versión A
}, { _id: false })

const scheduleSchema = new Schema({
  send_at:   { type: Date, default: null }, // null = inmediato al lanzar
  timezone:  { type: String, default: 'America/Bogota' },
  // Ventana horaria permitida (UTC hora local según timezone)
  allowed_hours: {
    start: { type: Number, default: 8,  min: 0, max: 23 }, // 8 AM
    end:   { type: Number, default: 20, min: 0, max: 23 }, // 8 PM
  },
  // Días permitidos: 0=Dom, 1=Lun ... 6=Sab (null = todos)
  allowed_days: { type: [Number], default: null },
}, { _id: false })

const dripStepSchema = new Schema({
  delay_days: { type: Number, required: true, min: 0 },
  template: {
    type:    { type: String, enum: ['text', 'hsm'], default: 'text' },
    content: { type: String, default: '' },
    subject: { type: String, default: null },
  },
}, { _id: false })

const triggerSchema = new Schema({
  event:           { type: String, enum: ['birthday', 'inactivity', 'cart_abandoned'], required: true },
  inactivity_days: { type: Number, default: 30 }, // solo para 'inactivity'
}, { _id: false })

const statsSchema = new Schema({
  total:     { type: Number, default: 0 },
  sent:      { type: Number, default: 0 },
  delivered: { type: Number, default: 0 },
  read:      { type: Number, default: 0 },
  replied:   { type: Number, default: 0 },
  failed:    { type: Number, default: 0 },
  opted_out: { type: Number, default: 0 },
  skipped:   { type: Number, default: 0 },
  // A/B
  sent_a:    { type: Number, default: 0 },
  replied_a: { type: Number, default: 0 },
  sent_b:    { type: Number, default: 0 },
  replied_b: { type: Number, default: 0 },
  // Conversiones
  conversations_created: { type: Number, default: 0 },
}, { _id: false })

// ─── Campaign schema principal ────────────────────────────────────────────────

const campaignSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  name:         { type: String, required: true, trim: true },

  // Canal de envío
  channel_id:   { type: Schema.Types.ObjectId, ref: 'Channel', required: true },
  channel_type: {
    type: String,
    enum: ['whatsapp', 'whatsapp_baileys', 'telegram', 'email', 'facebook_messenger', 'instagram_dm'],
    required: true,
  },

  // Tipo de campaña
  type: {
    type: String,
    enum: ['immediate', 'drip', 'trigger'],
    default: 'immediate',
  },

  // Estado del ciclo de vida
  status: {
    type: String,
    enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled'],
    default: 'draft',
  },

  audience:    { type: audienceSchema, default: () => ({}) },
  template:    { type: templateSchema, default: () => ({}) },
  schedule:    { type: scheduleSchema, default: () => ({}) },
  drip_steps:  { type: [dripStepSchema], default: [] },    // solo para type='drip'
  trigger:     { type: triggerSchema, default: null },       // solo para type='trigger'
  stats:       { type: statsSchema, default: () => ({}) },

  // UTM tracking
  utm: {
    source:   { type: String, default: null },
    medium:   { type: String, default: null },
    campaign: { type: String, default: null },
  },

  // Puntero de progreso del job (índice del último CampaignContact procesado)
  _job_offset: { type: Number, default: 0 },

  reply_behavior: {
    create_conversation:    { type: Boolean, default: true },
    route_to:               { type: String, enum: ['bot', 'agent', 'queue'], default: 'bot' },
    assigned_department_id: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
  },

  launched_at:   { type: Date, default: null },
  completed_at:  { type: Date, default: null },
  created_by:    { type: Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true })

campaignSchema.index({ workspace_id: 1, status: 1 })
campaignSchema.index({ workspace_id: 1, createdAt: -1 })
campaignSchema.index({ status: 1, 'schedule.send_at': 1 }) // para el job

module.exports = mongoose.model('Campaign', campaignSchema)
