'use strict'

/**
 * payments.js — Plugin Fastify para webhooks de confirmación de pago.
 *
 * Registra rutas POST /webhooks/payments/{pasarela}/:workspaceId
 * para las 6 pasarelas soportadas: Stripe, MercadoPago, PayPal, Wompi,
 * ePayco y PayU.
 *
 * Cada handler:
 *   1. Verifica la firma del webhook con el adaptador correspondiente
 *   2. Determina si el pago fue aprobado según el criterio de la pasarela
 *   3. Llama a handlePaymentConfirmed() para actualizar el PaymentLink,
 *      mover el Lead a 'won' y emitir el evento WebSocket al dashboard
 */

const PaymentLink    = require('../../db/models/payment-link')
const Lead           = require('../../db/models/lead')
const PaymentGateway = require('../../db/models/payment-gateway')
const msgService     = require('../../services/message.service')
const logger         = require('../../utils/logger')

// ─── Adaptadores de pasarelas ────────────────────────────────────────────────
const { verifyWebhookSignature: verifyStripeSignature }   = require('../../services/gateways/stripe.gateway')
const { verifyWebhookSignature: verifyMPSignature,
        getPayment: getMPPayment }                         = require('../../services/gateways/mercadopago.gateway')
const { verifyWebhookSignature: verifyPayPalSignature,
        getOrder: getPayPalOrder }                         = require('../../services/gateways/paypal.gateway')
const { verifyWebhookSignature: verifyWompiSignature }    = require('../../services/gateways/wompi.gateway')
const { verifyWebhookSignature: verifyEpaycoSignature }   = require('../../services/gateways/epayco.gateway')
const { verifyWebhookSignature: verifyPayUSignature }     = require('../../services/gateways/payu.gateway')

// ─── Helper compartido ────────────────────────────────────────────────────────

/**
 * Encapsula los pasos post-verificación de un pago confirmado:
 *   1. Actualiza PaymentLink → status 'paid'
 *   2. Busca el Lead asociado a la conversación y lo mueve a stage 'won'
 *   3. Envía mensaje de sistema en la conversación
 *   4. Emite evento WebSocket al workspace
 *
 * @param {object} fastify
 * @param {object} opts
 * @param {string}   opts.workspaceId
 * @param {string}   opts.paymentLinkId     - _id del PaymentLink en MongoDB
 * @param {string}   [opts.providerPaymentId] - ID del pago en la pasarela
 * @param {string}   opts.provider          - Nombre de la pasarela (para logs/WS)
 * @param {boolean}  [opts.alreadyUpdated]  - Si el link ya fue actualizado antes de llamar
 */
async function handlePaymentConfirmed(fastify, { workspaceId, paymentLinkId, providerPaymentId, provider, alreadyUpdated = false }) {
  let link

  if (alreadyUpdated) {
    link = await PaymentLink.findOne({ _id: paymentLinkId, workspace_id: workspaceId }).lean()
  } else {
    link = await PaymentLink.findOneAndUpdate(
      { _id: paymentLinkId, workspace_id: workspaceId, payment_status: 'pending' },
      {
        $set: {
          payment_status:      'paid',
          paid_at:             new Date(),
          provider_payment_id: providerPaymentId,
        },
      },
      { new: true }
    ).lean()
  }

  if (!link) {
    logger.debug({ paymentLinkId, provider }, '[Payment] PaymentLink no encontrado o ya procesado')
    return
  }

  logger.info({ paymentLinkId, provider, workspaceId }, '[Payment] Pago confirmado')

  if (!link.conversation_id) return

  // Buscar Lead asociado y mover a 'won'
  try {
    const lead = await Lead.findOne({
      workspace_id: workspaceId,
      conversation_id: link.conversation_id,
    }).sort({ createdAt: -1 }).lean()
    if (lead) {
      await Lead.updateOne({ _id: lead._id }, { $set: { stage: 'won' } })
    }
  } catch (err) {
    logger.warn({ err: err.message }, '[Payment] No se pudo actualizar stage del Lead')
  }

  // Enviar mensaje de confirmación al chat
  try {
    await msgService.createMessage({
      workspaceId,
      conversationId: link.conversation_id,
      senderType:     'system',
      type:           'text',
      content:        '✅ Pago confirmado. ¡Gracias por tu compra!',
    })

    fastify.io?.to(`workspace:${workspaceId}`).emit('payment:confirmed', {
      paymentLinkId:  link._id,
      conversationId: link.conversation_id,
      workspaceId,
    })
  } catch (err) {
    logger.warn({ err: err.message }, '[Payment] No se pudo enviar mensaje de confirmación')
  }
}

// ─── Plugin Fastify ───────────────────────────────────────────────────────────

async function paymentsWebhookPlugin(fastify, _opts) {

  // ── Stripe ──────────────────────────────────────────────────────────────────
  //
  // POST /webhooks/payments/stripe/:workspaceId
  // Configura esta URL en Stripe Dashboard → Developers → Webhooks.
  // Evento recomendado: checkout.session.completed

  fastify.post('/stripe/:workspaceId', {
    config: { rawBody: true },
    schema: {
      tags: ['Webhooks'],
      summary: 'Webhook de pagos Stripe',
      description: 'Recibe confirmaciones de pago de Stripe. Configura esta URL en Stripe Dashboard → Developers → Webhooks.',
      params: { type: 'object', properties: { workspaceId: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { received: { type: 'boolean' } } } },
    },
  }, async (request, reply) => {
    reply.code(200).send({ received: true })

    setImmediate(async () => {
      try {
        const { workspaceId } = request.params
        const signature = request.headers['stripe-signature']

        const gateway = await PaymentGateway.findOne({
          workspace_id: workspaceId,
          provider:     'stripe',
          active:       true,
        }).lean()

        if (!gateway?.credentials?.webhook_secret) {
          logger.warn({ workspaceId }, '[Stripe Webhook] No hay webhook_secret configurado')
          return
        }

        const event = verifyStripeSignature(request.rawBody, signature, gateway.credentials.webhook_secret)
        if (!event) {
          logger.warn({ workspaceId }, '[Stripe Webhook] Firma inválida')
          return
        }

        if (!['checkout.session.completed', 'payment_intent.succeeded'].includes(event.type)) return

        const session       = event.data.object
        const paymentLinkId = session.metadata?.payment_link_id
        if (!paymentLinkId) return

        await handlePaymentConfirmed(fastify, {
          workspaceId,
          paymentLinkId,
          providerPaymentId: session.payment_intent || session.id,
          provider: 'stripe',
        })
      } catch (err) {
        logger.error({ err: err.message }, '[Stripe Webhook] Error procesando evento')
      }
    })
  })

  // ── MercadoPago ─────────────────────────────────────────────────────────────
  //
  // POST /webhooks/payments/mercadopago/:workspaceId
  // MercadoPago envía notificaciones IPN/webhooks a esta URL.

  fastify.post('/mercadopago/:workspaceId', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Webhook de pagos MercadoPago',
      description: 'MercadoPago envía notificaciones IPN a esta URL cuando el estado de un pago cambia.',
      params: { type: 'object', properties: { workspaceId: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { received: { type: 'boolean' } } } },
    },
  }, async (request, reply) => {
    reply.code(200).send({ received: true })

    setImmediate(async () => {
      try {
        const { workspaceId } = request.params
        const body = request.body || {}

        // MP envía: { type: 'payment', data: { id: '123456' } }
        if (body.type !== 'payment' || !body.data?.id) return

        const gateway = await PaymentGateway.findOne({
          workspace_id: workspaceId,
          provider:     'mercadopago',
          active:       true,
        }).lean()

        if (!gateway?.credentials?.access_token) {
          logger.warn({ workspaceId }, '[MP Webhook] No hay access_token configurado')
          return
        }

        // Verificar firma si hay secret configurado (opcional en MP)
        const mpSecret = gateway.credentials.webhook_secret
        if (mpSecret) {
          const valid = verifyMPSignature(body, request.headers, mpSecret)
          if (!valid) {
            logger.warn({ workspaceId }, '[MP Webhook] Firma inválida')
            return
          }
        }

        // Consultar el pago en MP para obtener external_reference (= paymentLinkId)
        const payment = await getMPPayment(body.data.id, gateway.credentials.access_token)
        if (payment.status !== 'approved') return

        const paymentLinkId = payment.external_reference
        if (!paymentLinkId) return

        await handlePaymentConfirmed(fastify, {
          workspaceId,
          paymentLinkId,
          providerPaymentId: String(payment.id),
          provider: 'mercadopago',
        })
      } catch (err) {
        logger.error({ err: err.message }, '[MP Webhook] Error procesando notificación')
      }
    })
  })

  // ── PayPal ──────────────────────────────────────────────────────────────────
  //
  // POST /webhooks/payments/paypal/:workspaceId
  // Configura esta URL en PayPal Developer → Apps & Credentials → Webhooks.
  // Eventos: CHECKOUT.ORDER.APPROVED, PAYMENT.CAPTURE.COMPLETED

  fastify.post('/paypal/:workspaceId', {
    config: { rawBody: true },
    schema: {
      tags: ['Webhooks'],
      summary: 'Webhook de pagos PayPal',
      description: 'Configura esta URL en PayPal Developer → Apps & Credentials → Webhooks.',
      params: { type: 'object', properties: { workspaceId: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { received: { type: 'boolean' } } } },
    },
  }, async (request, reply) => {
    reply.code(200).send({ received: true })

    setImmediate(async () => {
      try {
        const { workspaceId } = request.params
        const body      = request.body || {}
        const eventType = body.event_type

        if (!['CHECKOUT.ORDER.APPROVED', 'PAYMENT.CAPTURE.COMPLETED'].includes(eventType)) return

        const gateway = await PaymentGateway.findOne({
          workspace_id: workspaceId,
          provider:     'paypal',
          active:       true,
        }).lean()

        if (!gateway?.credentials?.client_id) {
          logger.warn({ workspaceId }, '[PayPal Webhook] No hay client_id configurado')
          return
        }

        const { client_id, client_secret, webhook_id } = gateway.credentials
        const rawBody = request.rawBody?.toString?.() || JSON.stringify(body)

        const valid = await verifyPayPalSignature({
          webhookId:    webhook_id,
          headers:      request.headers,
          rawBody,
          clientId:     client_id,
          clientSecret: client_secret,
          testMode:     gateway.test_mode,
        })

        if (!valid) {
          logger.warn({ workspaceId }, '[PayPal Webhook] Firma inválida')
          return
        }

        // Extraer orderId según el tipo de evento
        let orderId
        if (eventType === 'CHECKOUT.ORDER.APPROVED') {
          orderId = body.resource?.id
        } else {
          orderId = body.resource?.supplementary_data?.related_ids?.order_id
        }
        if (!orderId) return

        const order = await getPayPalOrder(orderId, client_id, client_secret, gateway.test_mode)
        const paymentLinkId = order.purchase_units?.[0]?.custom_id
        if (!paymentLinkId) return

        const isCompleted = order.status === 'COMPLETED' || eventType === 'PAYMENT.CAPTURE.COMPLETED'
        if (!isCompleted) return

        await handlePaymentConfirmed(fastify, {
          workspaceId,
          paymentLinkId,
          providerPaymentId: orderId,
          provider: 'paypal',
        })
      } catch (err) {
        logger.error({ err: err.message }, '[PayPal Webhook] Error procesando evento')
      }
    })
  })

  // ── Wompi ───────────────────────────────────────────────────────────────────
  //
  // POST /webhooks/payments/wompi/:workspaceId
  // Configura esta URL en el Dashboard de Wompi → Configuración → Eventos.

  fastify.post('/wompi/:workspaceId', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Webhook de pagos Wompi',
      description: 'Configura esta URL en el Dashboard de Wompi → Configuración → Eventos.',
      params: { type: 'object', properties: { workspaceId: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { received: { type: 'boolean' } } } },
    },
  }, async (request, reply) => {
    reply.code(200).send({ received: true })

    setImmediate(async () => {
      try {
        const { workspaceId } = request.params
        const body = request.body || {}

        if (body.event !== 'transaction.updated') return

        const transaction = body.data?.transaction
        if (!transaction || transaction.status !== 'APPROVED') return

        const gateway = await PaymentGateway.findOne({
          workspace_id: workspaceId,
          provider:     'wompi',
          active:       true,
        }).lean()

        if (!gateway?.credentials?.events_secret) {
          logger.warn({ workspaceId }, '[Wompi Webhook] No hay events_secret configurado')
          return
        }

        const valid = verifyWompiSignature(body, gateway.credentials.events_secret)
        if (!valid) {
          logger.warn({ workspaceId }, '[Wompi Webhook] Firma inválida')
          return
        }

        // Wompi no tiene campo libre en el link; buscamos por provider_id (wompiId)
        const link = await PaymentLink.findOneAndUpdate(
          {
            workspace_id: workspaceId,
            provider:     'wompi',
            provider_id:  transaction.payment_link_id || transaction.reference,
            payment_status: 'pending',
          },
          { $set: { payment_status: 'paid', paid_at: new Date(), provider_payment_id: transaction.id } },
          { new: true }
        ).lean()

        if (!link) {
          logger.debug({ workspaceId, transactionId: transaction.id }, '[Wompi Webhook] Link no encontrado')
          return
        }

        await handlePaymentConfirmed(fastify, {
          workspaceId,
          paymentLinkId:     link._id,
          providerPaymentId: String(transaction.id),
          provider:          'wompi',
          alreadyUpdated:    true,
        })
      } catch (err) {
        logger.error({ err: err.message }, '[Wompi Webhook] Error procesando evento')
      }
    })
  })

  // ── ePayco ──────────────────────────────────────────────────────────────────
  //
  // POST /webhooks/payments/epayco/:workspaceId
  // ePayco envía los datos de confirmación como form POST a esta URL.

  fastify.post('/epayco/:workspaceId', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Webhook de pagos ePayco',
      description: 'ePayco envía una confirmación por POST cuando el pago cambia de estado. Configura esta URL en la cuenta de ePayco.',
      params: { type: 'object', properties: { workspaceId: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { received: { type: 'boolean' } } } },
    },
  }, async (request, reply) => {
    reply.code(200).send({ received: true })

    setImmediate(async () => {
      try {
        const { workspaceId } = request.params
        const params = request.body || {}

        // Solo procesar pagos aprobados
        if (params.x_cod_transaction_state !== '1' && params.x_response !== 'Aceptada') return

        const gateway = await PaymentGateway.findOne({
          workspace_id: workspaceId,
          provider:     'epayco',
          active:       true,
        }).lean()

        if (!gateway?.credentials?.p_key) {
          logger.warn({ workspaceId }, '[ePayco Webhook] No hay p_key configurado')
          return
        }

        const { p_cust_id_cliente, p_key } = gateway.credentials
        const valid = verifyEpaycoSignature(params, p_cust_id_cliente, p_key)
        if (!valid) {
          logger.warn({ workspaceId }, '[ePayco Webhook] Firma inválida')
          return
        }

        // extra1 contiene el paymentLinkId guardado al crear el link
        const paymentLinkId = params.x_extra1
        if (!paymentLinkId) {
          logger.warn({ workspaceId }, '[ePayco Webhook] No se encontró extra1 (paymentLinkId)')
          return
        }

        await handlePaymentConfirmed(fastify, {
          workspaceId,
          paymentLinkId,
          providerPaymentId: params.x_ref_payco || params.x_transaction_id,
          provider: 'epayco',
        })
      } catch (err) {
        logger.error({ err: err.message }, '[ePayco Webhook] Error procesando confirmación')
      }
    })
  })

  // ── PayU ────────────────────────────────────────────────────────────────────
  //
  // POST /webhooks/payments/payu/:workspaceId
  // PayU envía los datos de confirmación por POST a la confirmationUrl.
  // state_pol: 4 = aprobado, 6 = rechazado, 5 = expirado, 7 = pendiente

  fastify.post('/payu/:workspaceId', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Webhook de pagos PayU',
      description: [
        'PayU envía la confirmación de pago por POST a esta URL.',
        'Se configura automáticamente como `confirmationUrl` al crear el link.',
        '',
        '`state_pol` 4 = Aprobado, 6 = Rechazado, 5 = Expirado.',
      ].join('\n'),
      params: { type: 'object', properties: { workspaceId: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { received: { type: 'boolean' } } } },
    },
  }, async (request, reply) => {
    reply.code(200).send({ received: true })

    setImmediate(async () => {
      try {
        const { workspaceId } = request.params
        const params = request.body || {}

        // Solo procesar pagos aprobados (state_pol = 4)
        if (String(params.state_pol) !== '4') return

        const gateway = await PaymentGateway.findOne({
          workspace_id: workspaceId,
          provider:     'payu',
          active:       true,
        }).lean()

        if (!gateway?.credentials?.api_key) {
          logger.warn({ workspaceId }, '[PayU Webhook] No hay api_key configurado')
          return
        }

        const valid = verifyPayUSignature(params, gateway.credentials.api_key)
        if (!valid) {
          logger.warn({ workspaceId }, '[PayU Webhook] Firma inválida')
          return
        }

        // reference_sale es el paymentLinkId guardado al crear el link
        const paymentLinkId = params.reference_sale
        if (!paymentLinkId) {
          logger.warn({ workspaceId }, '[PayU Webhook] No se encontró reference_sale')
          return
        }

        await handlePaymentConfirmed(fastify, {
          workspaceId,
          paymentLinkId,
          providerPaymentId: params.transaction_id || params.reference_pol,
          provider: 'payu',
        })
      } catch (err) {
        logger.error({ err: err.message }, '[PayU Webhook] Error procesando confirmación')
      }
    })
  })
}

module.exports = paymentsWebhookPlugin
