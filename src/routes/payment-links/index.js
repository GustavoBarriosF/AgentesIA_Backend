'use strict'

/**
 * payment-links routes
 *
 * GET    /api/:workspaceId/payment-links        → historial de links
 * POST   /api/:workspaceId/payment-links        → crear link y enviarlo al chat
 * GET    /api/:workspaceId/payment-links/:id    → detalle de un link
 */

const PaymentLink    = require('../../db/models/payment-link')
const PaymentGateway = require('../../db/models/payment-gateway')
const Product        = require('../../db/models/product')
const Conversation   = require('../../db/models/conversation')
const { createPaymentLink } = require('../../services/gateways')
const channelService = require('../../services/channel.service')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

const PaymentLinkObject = {
  type: 'object',
  properties: {
    _id:                 { type: 'string' },
    workspace_id:        { type: 'string' },
    conversation_id:     { type: 'string', nullable: true },
    contact_id:          { type: 'string', nullable: true },
    provider:            { type: 'string' },
    provider_id:         { type: 'string' },
    provider_payment_id: { type: 'string', nullable: true },
    url:                 { type: 'string' },
    amount:              { type: 'number' },
    currency:            { type: 'string' },
    description:         { type: 'string' },
    items:               { type: 'array', items: { type: 'object', additionalProperties: true } },
    status:              { type: 'string', enum: ['pending', 'paid', 'expired', 'failed', 'cancelled'] },
    expires_at:          { type: 'string', format: 'date-time', nullable: true },
    paid_at:             { type: 'string', format: 'date-time', nullable: true },
    createdAt:           { type: 'string', format: 'date-time' },
    updatedAt:           { type: 'string', format: 'date-time' },
  },
}

async function paymentLinksRoutes(fastify) {
  const preHandler = [fastify.authenticate, fastify.requireWorkspace]

  // ─── GET /api/:workspaceId/payment-links ──────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Payment Links'],
      summary: 'Historial de links de pago',
      security,
      params: workspaceParam,
      querystring: {
        type: 'object',
        properties: {
          status:          { type: 'string', enum: ['pending', 'paid', 'expired', 'failed', 'cancelled'] },
          conversation_id: { type: 'string' },
          provider:        { type: 'string' },
          limit:           { type: 'integer', default: 50 },
          offset:          { type: 'integer', default: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data:  { type: 'array', items: PaymentLinkObject },
            total: { type: 'integer' },
          },
        },
      },
    },
  }, async (request) => {
    const { status, conversation_id, provider, limit = 50, offset = 0 } = request.query
    const query = { workspace_id: request.workspaceId }
    if (status)          query.status = status
    if (conversation_id) query.conversation_id = conversation_id
    if (provider)        query.provider = provider

    const [data, total] = await Promise.all([
      PaymentLink.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      PaymentLink.countDocuments(query),
    ])

    return { data, total }
  })

  // ─── POST /api/:workspaceId/payment-links ─────────────────────────────────
  fastify.post('/', {
    preHandler,
    schema: {
      tags: ['Payment Links'],
      summary: 'Crear link de pago y enviarlo al chat',
      description: [
        'Genera un link de pago usando la pasarela configurada del workspace y lo envía',
        'automáticamente al canal de la conversación especificada.',
        '',
        '**items** puede ser una lista de product_ids o items personalizados.',
        'Si se usa product_id, el precio se toma del catálogo.',
      ].join('\n'),
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['provider', 'currency'],
        properties: {
          provider:        { type: 'string', enum: ['stripe', 'mercadopago', 'paypal', 'wompi', 'epayco'] },
          conversation_id: { type: 'string', description: 'Si se provee, el link se envía automáticamente al chat' },
          description:     { type: 'string', description: 'Descripción visible en el checkout' },
          currency:        { type: 'string', default: 'USD', maxLength: 3 },
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                product_id: { type: 'string', description: 'ID del producto del catálogo (opcional)' },
                name:       { type: 'string' },
                quantity:   { type: 'integer', minimum: 1, default: 1 },
                unit_price: { type: 'number', minimum: 0 },
              },
            },
          },
          payer_email:     { type: 'string', description: 'Email del comprador (MercadoPago)' },
          send_to_chat:    { type: 'boolean', default: true, description: 'Enviar el link al chat automáticamente' },
        },
      },
      response: { 201: PaymentLinkObject, 400: errorResponse, 404: errorResponse },
    },
  }, async (request, reply) => {
    const {
      provider,
      conversation_id,
      description = 'Pago',
      currency,
      items: rawItems,
      payer_email,
      send_to_chat = true,
    } = request.body

    // 1. Obtener configuración de la pasarela
    const gateway = await PaymentGateway.findOne({
      workspace_id: request.workspaceId,
      provider,
      active: true,
    }).lean()

    if (!gateway) {
      return reply.code(404).send({ error: `Pasarela '${provider}' no configurada o inactiva para este workspace` })
    }

    // 2. Resolver items (expandir product_ids si aplica)
    const items = []
    for (const raw of rawItems) {
      if (raw.product_id) {
        const product = await Product.findOne({
          _id: raw.product_id,
          workspace_id: request.workspaceId,
          active: true,
        }).lean()
        if (!product) {
          return reply.code(404).send({ error: `Producto ${raw.product_id} no encontrado` })
        }
        items.push({
          product_id: product._id,
          name:       product.name,
          quantity:   raw.quantity || 1,
          unit_price: product.price,
          currency:   product.currency || currency,
        })
      } else {
        if (!raw.name || raw.unit_price === undefined) {
          return reply.code(400).send({ error: 'Cada item necesita name y unit_price si no se usa product_id' })
        }
        items.push({
          product_id: null,
          name:       raw.name,
          quantity:   raw.quantity || 1,
          unit_price: raw.unit_price,
          currency,
        })
      }
    }

    const amount = items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0)

    // 3. Crear el PaymentLink en BD (necesitamos el ID para la metadata)
    const contact_id = conversation_id
      ? (await Conversation.findOne({ _id: conversation_id, workspace_id: request.workspaceId }).select('contact_id').lean())?.contact_id
      : null

    const paymentLinkDoc = await PaymentLink.create({
      workspace_id:    request.workspaceId,
      conversation_id: conversation_id || null,
      contact_id:      contact_id || null,
      provider,
      provider_id:     'pending',  // se actualiza abajo
      url:             'pending',
      amount,
      currency:        currency.toUpperCase(),
      description,
      items,
      status:          'pending',
    })

    // 4. Crear el link en la pasarela
    let gatewayResult
    try {
      gatewayResult = await createPaymentLink({
        gateway,
        workspaceId:   request.workspaceId,
        paymentLinkId: paymentLinkDoc._id.toString(),
        items,
        currency,
        description,
        payerEmail: payer_email,
      })
    } catch (err) {
      await PaymentLink.deleteOne({ _id: paymentLinkDoc._id })
      return reply.code(502).send({ error: err.message })
    }

    // 5. Actualizar el PaymentLink con URL y provider_id reales
    const updated = await PaymentLink.findByIdAndUpdate(
      paymentLinkDoc._id,
      { $set: { url: gatewayResult.url, provider_id: gatewayResult.providerId } },
      { new: true }
    )

    // 6. Enviar al chat si se solicitó
    if (send_to_chat && conversation_id) {
      try {
        const conv = await Conversation.findOne({
          _id: conversation_id,
          workspace_id: request.workspaceId,
        }).populate('channel_id').lean()

        if (conv?.channel_id) {
          const msg = `💳 *${description}*\nTotal: ${currency.toUpperCase()} ${amount.toFixed(2)}\n\n👉 Pagar aquí: ${gatewayResult.url}`
          await channelService.sendMessage(conv.channel_id, conv.contact_ref, msg)
        }
      } catch (err) {
        request.log.warn({ err: err.message }, '[PaymentLinks] No se pudo enviar link al chat')
      }
    }

    return reply.code(201).send(updated.toObject())
  })

  // ─── GET /api/:workspaceId/payment-links/:id ──────────────────────────────
  fastify.get('/:id', {
    preHandler,
    schema: {
      tags: ['Payment Links'],
      summary: 'Detalle de un link de pago',
      security,
      params: { ...workspaceParam, properties: { ...workspaceParam.properties, id: { type: 'string' } } },
      response: { 200: PaymentLinkObject, 404: errorResponse },
    },
  }, async (request, reply) => {
    const link = await PaymentLink.findOne({
      _id: request.params.id,
      workspace_id: request.workspaceId,
    }).lean()
    if (!link) return reply.code(404).send({ error: 'Link de pago no encontrado' })
    return link
  })
}

module.exports = paymentLinksRoutes
