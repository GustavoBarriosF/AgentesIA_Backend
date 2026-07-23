'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const planSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true, unique: true },
  tier: { type: String, enum: ['free', 'starter', 'pro', 'enterprise'], default: 'free' },
  limits: {
    conversations_per_month: { type: Number, default: 100 },
    agents: { type: Number, default: 2 },
    channels: { type: Number, default: 1 },
    storage_gb: { type: Number, default: 1 },
    knowledge_items: { type: Number, default: 50 },
    bots: { type: Number, default: 0 },
  },
  usage: {
    conversations_this_month: { type: Number, default: 0 },
    period_start: { type: Date, default: Date.now },
  },
  stripe_sub_id: { type: String, default: null },
  stripe_cus_id: { type: String, default: null },
  status: {
    type: String,
    enum: ['active', 'past_due', 'canceled', 'trialing', 'suspended'],
    default: 'active',
  },
  trial_ends_at:    { type: Date, default: null },
  trial_started_at: { type: Date, default: null },
  billing_cycle:    { type: String, enum: ['monthly', 'yearly', null], default: null },
  next_billing_date: { type: Date, default: null },
  coupon_applied:   { type: String, default: null },

  // Referencia a la PlanDefinition que define este plan (sincroniza límites)
  plan_definition_id: { type: Schema.Types.ObjectId, ref: 'PlanDefinition', default: null },

  // Campos de suspensión
  suspended_at:      { type: Date, default: null },
  suspension_reason: { type: String, default: null },

  // Campos de override manual por superadmin
  override_by:   { type: String, default: null }, // email del superadmin
  override_note: { type: String, default: null },
}, { timestamps: true })

module.exports = mongoose.model('Plan', planSchema)
