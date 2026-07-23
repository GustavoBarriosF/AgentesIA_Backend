'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

/**
 * PaymentGateway — configuración de pasarela de pago por workspace.
 *
 * Cada workspace puede tener una configuración por proveedor.
 * Las credenciales son del CLIENTE (no de NexoraChat).
 *
 * credentials por proveedor:
 *   stripe:       { secret_key, webhook_secret, publishable_key }
 *   mercadopago:  { access_token }
 *   paypal:       { client_id, client_secret, webhook_id }
 *   wompi:        { public_key, private_key, events_secret }
 *   epayco:       { p_cust_id_cliente, p_key, public_key, private_key }
 *
 * Las credenciales NUNCA se devuelven completas al frontend —
 * solo se indica si están configuradas (campo `configured`).
 */
const paymentGatewaySchema = new Schema({
  workspace_id: {
    type: Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
  },
  provider: {
    type: String,
    enum: ['stripe', 'mercadopago', 'paypal', 'wompi', 'epayco', 'payu'],
    required: true,
  },
  // Credenciales del cliente — flexibles por proveedor
  credentials: {
    type: Schema.Types.Mixed,
    default: {},
  },
  active: {
    type: Boolean,
    default: true,
  },
  test_mode: {
    type: Boolean,
    default: false,
    description: 'true = usar credenciales de prueba / sandbox',
  },
}, { timestamps: true })

// Un workspace solo puede tener una config por proveedor
paymentGatewaySchema.index({ workspace_id: 1, provider: 1 }, { unique: true })

module.exports = mongoose.model('PaymentGateway', paymentGatewaySchema)
