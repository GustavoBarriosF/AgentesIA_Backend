'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const couponSchema = new Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
  },
  description: { type: String, default: '' },

  // Tipo de descuento
  type: {
    type: String,
    enum: ['percent', 'fixed_amount', 'free_trial_days'],
    required: true,
  },

  // Valor del descuento:
  // - percent: porcentaje (0-100)
  // - fixed_amount: centavos USD
  // - free_trial_days: número de días
  value: { type: Number, required: true, min: 0 },

  // A qué tiers aplica
  applies_to: {
    type: String,
    enum: ['all', 'specific_tiers'],
    default: 'all',
  },
  applicable_tiers: {
    type: [String],
    default: [],
    // Valores: 'starter', 'pro', 'enterprise'
  },

  // Límite de usos (null = ilimitado)
  max_uses:   { type: Number, default: null },
  used_count: { type: Number, default: 0 },

  // Vigencia
  valid_from:  { type: Date, default: Date.now },
  valid_until: { type: Date, default: null }, // null = sin vencimiento

  active: { type: Boolean, default: true },

  // ID del cupón en Stripe si fue creado allí también
  stripe_coupon_id: { type: String, default: null },
}, { timestamps: true })

couponSchema.index({ code: 1 })
couponSchema.index({ active: 1, valid_until: 1 })

module.exports = mongoose.model('Coupon', couponSchema)
