'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const planDefinitionSchema = new Schema({
  tier: {
    type: String,
    enum: ['free', 'starter', 'pro', 'enterprise'],
    required: true,
    unique: true,
  },
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },

  // Precios en centavos USD (0 = gratis)
  price_monthly: { type: Number, default: 0, min: 0 },
  price_yearly:  { type: Number, default: 0, min: 0 },

  // IDs de Price en Stripe (null si no tiene Stripe configurado)
  stripe_price_id_monthly: { type: String, default: null },
  stripe_price_id_yearly:  { type: String, default: null },
  stripe_product_id:       { type: String, default: null },

  limits: {
    conversations_per_month: { type: Number, default: 100 },
    agents:                  { type: Number, default: 2 },
    channels:                { type: Number, default: 1 },
    storage_gb:              { type: Number, default: 1 },
    knowledge_items:         { type: Number, default: 50 },
    bots:                    { type: Number, default: 0 },
  },

  // Features disponibles en este plan
  features: {
    type: [String],
    default: [],
    // Posibles valores: 'whatsapp', 'telegram', 'api', 'bot', 'analytics',
    //                   'sla', 'knowledge_base', 'leads', 'api_access', 'custom_branding'
  },

  trial_days: { type: Number, default: 0, min: 0 },
  active:     { type: Boolean, default: true },
  sort_order: { type: Number, default: 0 },
}, { timestamps: true })

module.exports = mongoose.model('PlanDefinition', planDefinitionSchema)
