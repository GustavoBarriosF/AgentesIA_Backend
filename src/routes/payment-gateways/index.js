'use strict'

/**
 * payment-gateways routes
 *
 * GET    /api/:workspaceId/payment-gateways                       → listar configs (sin credenciales)
 * PUT    /api/:workspaceId/payment-gateways/:provider             → guardar config
 * POST   /api/:workspaceId/payment-gateways/:provider/verify      → verificar credenciales
 * DELETE /api/:workspaceId/payment-gateways/:provider             → eliminar config
 */

const PaymentGateway = require('../../db/models/payment-gateway')
const { verifyGatewayCredentials } = require('../../services/gateways')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

const PROVIDERS = ['stripe', 'mercadopago', 'paypal', 'wompi', 'epayco', 'payu']

/** Retorna el objeto de gateway sin credenciales sensibles */
function toSafeResponse(gw) {
  if (!gw) return null
  const { credentials, ...rest } = gw
  // Solo retornar qué campos están configurados, no los valores
  const configured = {}
  if (credentials) {
    Object.keys(credentials).forEach(k => {
      configured[k] = !!credentials[k]
    })
  }
  return { ...rest, credentials_configured: configured }
}

const GatewayObject = {
  type: 'object',
  properties: {
    _id:                    { type: 'string' },
    workspace_id:           { type: 'string' },
    provider:               { type: 'string', enum: PROVIDERS },
    active:                 { type: 'boolean' },
    test_mode:              { type: 'boolean' },
    credentials_configured: { type: 'object', additionalProperties: { type: 'boolean' } },
    createdAt:              { type: 'string', format: 'date-time' },
    updatedAt:              { type: 'string', format: 'date-time' },
  },
}

async function paymentGatewaysRoutes(fastify) {
  const preHandler   = [fastify.authenticate, fastify.requireWorkspace]
  const adminHandler = [...preHandler, fastify.requireRole('admin')]

  // ─── GET ──────────────────────────────────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Payment Gateways'],
      summary: 'Listar pasarelas configuradas (sin credenciales)',
      security,
      params: workspaceParam,
      response: { 200: { type: 'array', items: GatewayObject } },
    },
  }, async (request) => {
    const gateways = await PaymentGateway.find({ workspace_id: request.workspaceId }).lean()
    return gateways.map(toSafeResponse)
  })

  // ─── PUT /:provider ───────────────────────────────────────────────────────
  fastify.put('/:provider', {
    preHandler: adminHandler,
    schema: {
      tags: ['Payment Gateways'],
      summary: 'Guardar configuración de pasarela',
      description: [
        'Crea o actualiza la configuración de una pasarela de pago.',
        '',
        '**Campos de credentials por proveedor:**',
        '- stripe:      `{ secret_key, webhook_secret, publishable_key, success_url, cancel_url }`',
        '- mercadopago: `{ access_token, success_url, cancel_url }`',
        '- paypal:      `{ client_id, client_secret, webhook_id }`',
        '- wompi:       `{ public_key, private_key, events_secret }`',
        '- epayco:      `{ p_cust_id_cliente, p_key, public_key, private_key }`',
        '',
        'Si se omite un campo de credentials, se conserva el valor existente.',
      ].join('\n'),
      security,
      params: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          provider:    { type: 'string', enum: PROVIDERS },
        },
      },
      body: {
        type: 'object',
        properties: {
          credentials: { type: 'object', additionalProperties: true },
          active:      { type: 'boolean' },
          test_mode:   { type: 'boolean' },
        },
      },
      response: { 200: GatewayObject, 400: errorResponse },
    },
  }, async (request) => {
    const { provider } = request.params
    const { credentials, active, test_mode } = request.body

    // Obtener config existente para merge de credenciales
    const existing = await PaymentGateway.findOne({
      workspace_id: request.workspaceId,
      provider,
    }).lean()

    const mergedCredentials = {
      ...(existing?.credentials || {}),
      ...(credentials || {}),
    }

    // Filtrar campos vacíos (enviar "" para borrar un campo)
    Object.keys(mergedCredentials).forEach(k => {
      if (mergedCredentials[k] === '') delete mergedCredentials[k]
    })

    const setData = {
      credentials: mergedCredentials,
      ...(active      !== undefined ? { active }    : {}),
      ...(test_mode   !== undefined ? { test_mode } : {}),
    }

    const gw = await PaymentGateway.findOneAndUpdate(
      { workspace_id: request.workspaceId, provider },
      { $set: setData },
      { upsert: true, new: true }
    )

    return toSafeResponse(gw.toObject())
  })

  // ─── POST /:provider/verify ───────────────────────────────────────────────
  fastify.post('/:provider/verify', {
    preHandler: adminHandler,
    schema: {
      tags: ['Payment Gateways'],
      summary: 'Verificar credenciales de una pasarela',
      security,
      params: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          provider:    { type: 'string', enum: PROVIDERS },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid:        { type: 'boolean' },
            account_id:   { type: 'string', nullable: true },
            display_name: { type: 'string', nullable: true },
            user_id:      { type: 'number', nullable: true },
            email:        { type: 'string', nullable: true },
            site_id:      { type: 'string', nullable: true },
            error:        { type: 'string', nullable: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { provider } = request.params
    const gw = await PaymentGateway.findOne({
      workspace_id: request.workspaceId,
      provider,
    }).lean()

    if (!gw) return reply.code(404).send({ error: 'Pasarela no configurada' })

    const result = await verifyGatewayCredentials(provider, gw.credentials || {}, gw.test_mode || false)
    return result
  })

  // ─── DELETE /:provider ────────────────────────────────────────────────────
  fastify.delete('/:provider', {
    preHandler: adminHandler,
    schema: {
      tags: ['Payment Gateways'],
      summary: 'Eliminar configuración de pasarela',
      security,
      params: {
        type: 'object',
        properties: {
          workspaceId: { type: 'string' },
          provider:    { type: 'string', enum: PROVIDERS },
        },
      },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } } },
    },
  }, async (request) => {
    await PaymentGateway.deleteOne({
      workspace_id: request.workspaceId,
      provider:     request.params.provider,
    })
    return { ok: true }
  })
}

module.exports = paymentGatewaysRoutes
