'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const invoiceSchema = new Schema({
  workspace_id: {
    type: Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
  },

  // Referencia a Stripe (null si es factura manual/interna)
  stripe_invoice_id: { type: String, default: null, sparse: true },

  // Monto en centavos USD
  amount:   { type: Number, required: true, min: 0 },
  currency: { type: String, default: 'usd', lowercase: true },

  status: {
    type: String,
    enum: ['draft', 'open', 'paid', 'void', 'uncollectible'],
    default: 'open',
  },

  // Período de facturación
  period_start: { type: Date, required: true },
  period_end:   { type: Date, required: true },

  // Plan facturado
  tier:           { type: String, default: null },
  billing_cycle:  { type: String, enum: ['monthly', 'yearly', null], default: null },

  // URLs de Stripe
  invoice_url: { type: String, default: null },
  pdf_url:     { type: String, default: null },

  // Líneas de detalle
  items: {
    type: [{
      description: { type: String },
      amount:      { type: Number },
    }],
    default: [],
  },

  paid_at: { type: Date, default: null },

  // Para facturas creadas manualmente por superadmin
  notes: { type: String, default: null },
}, { timestamps: true })

invoiceSchema.index({ workspace_id: 1, createdAt: -1 })
invoiceSchema.index({ status: 1 })
invoiceSchema.index({ stripe_invoice_id: 1 }, { sparse: true })

module.exports = mongoose.model('Invoice', invoiceSchema)
