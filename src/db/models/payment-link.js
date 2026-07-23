'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

/**
 * PaymentLink — links de pago generados por el bot y enviados al cliente final.
 *
 * Flujo:
 *   1. Bot llama POST /api/:workspaceId/payment-links
 *   2. Se crea el link en la pasarela (Stripe Checkout, MP Preference, etc.)
 *   3. El URL se envía al contacto en el chat
 *   4. Contacto paga → pasarela envía webhook a /webhooks/payments/:provider/:workspaceId
 *   5. status cambia a 'paid', se emite evento WS y se envía mensaje de confirmación
 */
const paymentLinkSchema = new Schema({
  workspace_id: {
    type: Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true,
  },
  conversation_id: {
    type: Schema.Types.ObjectId,
    ref: 'Conversation',
    default: null,
  },
  contact_id: {
    type: Schema.Types.ObjectId,
    ref: 'Contact',
    default: null,
  },
  provider: {
    type: String,
    enum: ['stripe', 'mercadopago', 'paypal', 'wompi', 'epayco', 'payu'],
    required: true,
  },
  // ID del objeto en la pasarela (Stripe session ID, MP preference ID, etc.)
  provider_id: {
    type: String,
    required: true,
    index: true,
  },
  // ID del pago confirmado (Stripe payment_intent, MP payment ID, etc.)
  provider_payment_id: {
    type: String,
    default: null,
  },
  // URL enviada al cliente
  url: {
    type: String,
    required: true,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  currency: {
    type: String,
    required: true,
    uppercase: true,
    maxlength: 3,
  },
  description: {
    type: String,
    default: '',
  },
  // Productos incluidos en este link
  items: [{
    _id: false,
    product_id: { type: Schema.Types.ObjectId, ref: 'Product', default: null },
    name:        { type: String, required: true },
    quantity:    { type: Number, required: true, min: 1 },
    unit_price:  { type: Number, required: true, min: 0 },
  }],
  status: {
    type: String,
    enum: ['pending', 'paid', 'expired', 'failed', 'cancelled'],
    default: 'pending',
    index: true,
  },
  expires_at: {
    type: Date,
    default: null,
  },
  paid_at: {
    type: Date,
    default: null,
  },
  // Estado del pago (tracking independiente del status del link)
  payment_status: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'expired'],
    default: 'pending',
  },
  // ID del pago en la pasarela externa (distinto al provider_payment_id del link)
  gateway_payment_id: { type: String, default: null },
  // Datos adicionales del webhook de confirmación
  metadata: {
    type: Schema.Types.Mixed,
    default: {},
  },
}, { timestamps: true })

paymentLinkSchema.index({ workspace_id: 1, status: 1 })
paymentLinkSchema.index({ workspace_id: 1, payment_status: 1 })
paymentLinkSchema.index({ workspace_id: 1, conversation_id: 1 })
paymentLinkSchema.index({ provider: 1, provider_id: 1 })

module.exports = mongoose.model('PaymentLink', paymentLinkSchema)
