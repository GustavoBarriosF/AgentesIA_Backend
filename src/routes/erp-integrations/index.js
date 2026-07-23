'use strict'

/**
 * ERP Integrations routes
 *
 * Todas las rutas se montan bajo /api/:workspaceId
 *
 * ── Gestión de integraciones ──────────────────────────────────────────────────
 * GET    /api/:workspaceId/erp-integrations
 * POST   /api/:workspaceId/erp-integrations
 * PUT    /api/:workspaceId/erp-integrations/:id
 * DELETE /api/:workspaceId/erp-integrations/:id
 * POST   /api/:workspaceId/erp-integrations/:id/test
 * GET    /api/:workspaceId/erp-integrations/:id/logs
 *
 * ── Operaciones ERP (bot + dashboard) ────────────────────────────────────────
 * GET    /api/:workspaceId/erp/customer/:identifier
 * GET    /api/:workspaceId/erp/balance/:identifier
 * GET    /api/:workspaceId/erp/invoices/:customerId
 * POST   /api/:workspaceId/erp/invoice
 * POST   /api/:workspaceId/erp/payment/:invoiceId
 */

const erpService = require('../../services/erp.service')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

const PROVIDERS = ['alegra', 'siigo', 'quickbooks']

const IntegrationResponse = {
  type: 'object',
  properties: {
    _id:                    { type: 'string' },
    workspace_id:           { type: 'string' },
    provider:               { type: 'string', enum: PROVIDERS },
    active:                 { type: 'boolean' },
    config:                 { type: 'object' },
    credentials_configured: { type: 'object' },
    last_sync:              { type: ['string', 'null'], format: 'date-time' },
    last_error:             { type: ['string', 'null'] },
    createdAt:              { type: 'string', format: 'date-time' },
    updatedAt:              { type: 'string', format: 'date-time' },
  },
}

const integrationIdParam = {
  type: 'object',
  required: ['workspaceId', 'id'],
  properties: {
    workspaceId: { type: 'string' },
    id:          { type: 'string' },
  },
}

async function erpRoutes(fastify) {
  const preHandler   = [fastify.authenticate, fastify.requireWorkspace]
  const adminHandler = [...preHandler, fastify.requireRole('admin')]

  // ══════════════════════════════════════════════════════════════════════════
  // GESTIÓN DE INTEGRACIONES (CRUD)
  // ══════════════════════════════════════════════════════════════════════════

  // GET /erp-integrations
  fastify.get('/erp-integrations', {
    preHandler,
    schema: {
      tags: ['ERP Integrations'],
      summary: 'Listar integraciones ERP del workspace',
      security,
      params: workspaceParam,
      response: { 200: { type: 'array', items: IntegrationResponse } },
    },
  }, async (request) => {
    return erpService.listIntegrations(request.workspaceId)
  })

  // POST /erp-integrations
  fastify.post('/erp-integrations', {
    preHandler: adminHandler,
    schema: {
      tags: ['ERP Integrations'],
      summary: 'Conectar integración ERP',
      description: [
        'Crea una integración ERP para el workspace. Las credenciales se encriptan en reposo con AES-256-GCM.',
        '',
        '**Credenciales por proveedor:**',
        '- `alegra`:      `{ email, token }`',
        '- `siigo`:       `{ username, access_key }`',
        '- `quickbooks`:  `{ client_id, client_secret, realm_id, refresh_token, sandbox? }`',
      ].join('\n'),
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['provider', 'credentials'],
        properties: {
          provider:    { type: 'string', enum: PROVIDERS },
          credentials: {
            type: 'object',
            description: 'Credenciales específicas del proveedor',
            additionalProperties: true,
          },
          config: {
            type: 'object',
            properties: {
              currency:     { type: 'string', default: 'COP' },
              company_name: { type: 'string' },
              tax_included: { type: 'boolean', default: false },
              field_map:    { type: 'object', additionalProperties: true },
            },
          },
        },
      },
      response: {
        201: IntegrationResponse,
        409: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { provider, credentials, config } = request.body
    const result = await erpService.createIntegration(request.workspaceId, { provider, credentials, config })
    return reply.code(201).send(result)
  })

  // PUT /erp-integrations/:id
  fastify.put('/erp-integrations/:id', {
    preHandler: adminHandler,
    schema: {
      tags: ['ERP Integrations'],
      summary: 'Actualizar credenciales o configuración',
      security,
      params: integrationIdParam,
      body: {
        type: 'object',
        properties: {
          credentials: { type: 'object', additionalProperties: true },
          config: {
            type: 'object',
            properties: {
              currency:     { type: 'string' },
              company_name: { type: 'string' },
              tax_included: { type: 'boolean' },
              field_map:    { type: 'object', additionalProperties: true },
            },
          },
          active: { type: 'boolean' },
        },
      },
      response: {
        200: IntegrationResponse,
        404: errorResponse,
      },
    },
  }, async (request) => {
    const { credentials, config, active } = request.body
    return erpService.updateIntegration(request.workspaceId, request.params.id, { credentials, config, active })
  })

  // DELETE /erp-integrations/:id
  fastify.delete('/erp-integrations/:id', {
    preHandler: adminHandler,
    schema: {
      tags: ['ERP Integrations'],
      summary: 'Desconectar integración ERP',
      security,
      params: integrationIdParam,
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        404: errorResponse,
      },
    },
  }, async (request) => {
    await erpService.deleteIntegration(request.workspaceId, request.params.id)
    return { success: true }
  })

  // POST /erp-integrations/:id/test
  fastify.post('/erp-integrations/:id/test', {
    preHandler: adminHandler,
    schema: {
      tags: ['ERP Integrations'],
      summary: 'Probar conectividad con el ERP',
      security,
      params: integrationIdParam,
      response: {
        200: {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
            error: { type: 'string' },
          },
        },
        404: errorResponse,
      },
    },
  }, async (request) => {
    return erpService.testConnection(request.workspaceId, request.params.id)
  })

  // GET /erp-integrations/:id/logs
  fastify.get('/erp-integrations/:id/logs', {
    preHandler,
    schema: {
      tags: ['ERP Integrations'],
      summary: 'Historial de sincronizaciones y errores',
      security,
      params: integrationIdParam,
      response: {
        200: {
          type: 'object',
          properties: {
            last_sync:  { type: ['string', 'null'], format: 'date-time' },
            last_error: { type: ['string', 'null'] },
            sync_log: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  timestamp: { type: 'string', format: 'date-time' },
                  action:    { type: 'string' },
                  status:    { type: 'string', enum: ['success', 'error'] },
                  detail:    { type: ['string', 'null'] },
                },
              },
            },
          },
        },
        404: errorResponse,
      },
    },
  }, async (request) => {
    return erpService.getSyncLog(request.workspaceId, request.params.id)
  })

  // ══════════════════════════════════════════════════════════════════════════
  // OPERACIONES ERP DIRECTAS (usadas por el bot y el dashboard)
  // ══════════════════════════════════════════════════════════════════════════

  const erpIdentifierParam = {
    type: 'object',
    required: ['workspaceId', 'identifier'],
    properties: {
      workspaceId: { type: 'string' },
      identifier:  { type: 'string' },
    },
  }

  // GET /erp/customer/:identifier
  fastify.get('/erp/customer/:identifier', {
    preHandler,
    schema: {
      tags: ['ERP Operations'],
      summary: 'Buscar cliente en el ERP por cédula, NIT o email',
      description: 'Resultado cacheado 5 minutos en Redis.',
      security,
      params: erpIdentifierParam,
      response: {
        200: { type: 'object', additionalProperties: true },
        404: errorResponse,
        422: errorResponse,
      },
    },
  }, async (request, reply) => {
    const customer = await erpService.getCustomer(request.workspaceId, request.params.identifier)
    if (!customer) return reply.code(404).send({ error: 'Cliente no encontrado en el ERP' })
    return customer
  })

  // GET /erp/balance/:identifier
  fastify.get('/erp/balance/:identifier', {
    preHandler,
    schema: {
      tags: ['ERP Operations'],
      summary: 'Estado de cuenta del cliente (cartera)',
      description: 'Busca el cliente por identifier y consulta su balance. Cacheado 5 min.',
      security,
      params: erpIdentifierParam,
      response: {
        200: {
          type: 'object',
          properties: {
            customer_id:   { type: 'string' },
            total_balance: { type: 'number' },
            pending_count: { type: 'number' },
            invoices: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        404: errorResponse,
        422: errorResponse,
      },
    },
  }, async (request, reply) => {
    const { identifier } = request.params
    const customer = await erpService.getCustomer(request.workspaceId, identifier)
    if (!customer) return reply.code(404).send({ error: 'Cliente no encontrado en el ERP' })

    const customerId = String(customer.id || customer._id || customer.customer_id || customer.code || '')
    return erpService.getAccountBalance(request.workspaceId, customerId, identifier)
  })

  // GET /erp/invoices/:customerId
  fastify.get('/erp/invoices/:customerId', {
    preHandler,
    schema: {
      tags: ['ERP Operations'],
      summary: 'Facturas del cliente en el ERP',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'customerId'],
        properties: {
          workspaceId: { type: 'string' },
          customerId:  { type: 'string', description: 'ID interno del cliente en el ERP' },
        },
      },
      response: {
        200: { type: 'array', items: { type: 'object', additionalProperties: true } },
        422: errorResponse,
      },
    },
  }, async (request) => {
    return erpService.getInvoices(request.workspaceId, request.params.customerId)
  })

  // POST /erp/invoice
  fastify.post('/erp/invoice', {
    preHandler: adminHandler,
    schema: {
      tags: ['ERP Operations'],
      summary: 'Crear factura en el ERP',
      description: [
        'La estructura del body varía por proveedor:',
        '- **Alegra:** `{ client: { id }, items: [{ id, quantity, price }], date }`',
        '- **Siigo:** `{ document: { id }, customer: { identification }, items: [...] }`',
        '- **QuickBooks:** `{ CustomerRef: { value }, Line: [...] }`',
      ].join('\n'),
      security,
      params: workspaceParam,
      body: { type: 'object', additionalProperties: true },
      response: {
        201: { type: 'object', additionalProperties: true },
        422: errorResponse,
      },
    },
  }, async (request, reply) => {
    const invoice = await erpService.createInvoice(request.workspaceId, request.body)
    return reply.code(201).send(invoice)
  })

  // POST /erp/payment/:invoiceId
  fastify.post('/erp/payment/:invoiceId', {
    preHandler: adminHandler,
    schema: {
      tags: ['ERP Operations'],
      summary: 'Registrar pago de factura en el ERP',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'invoiceId'],
        properties: {
          workspaceId: { type: 'string' },
          invoiceId:   { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['amount'],
        properties: {
          amount:      { type: 'number' },
          customer_id: { type: 'string' },
          identifier:  { type: 'string', description: 'Cédula/NIT para invalidar caché' },
          date:        { type: 'string' },
          notes:       { type: 'string' },
        },
        additionalProperties: true,
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        422: errorResponse,
      },
    },
  }, async (request) => {
    return erpService.registerPayment(request.workspaceId, request.params.invoiceId, request.body)
  })
}

module.exports = erpRoutes
