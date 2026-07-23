'use strict'

/**
 * Campaigns routes — /api/:workspaceId/campaigns
 *
 * GET    /                         → listar campañas (paginado + filtros)
 * POST   /                         → crear campaña (draft)
 * GET    /:id                      → obtener campaña
 * PUT    /:id                      → actualizar campaña (solo draft)
 * DELETE /:id                      → eliminar campaña (solo draft/cancelled)
 * POST   /:id/launch               → lanzar campaña
 * POST   /:id/pause                → pausar campaña running
 * POST   /:id/cancel               → cancelar campaña
 * GET    /:id/contacts             → lista de contactos de la campaña (paginado)
 * GET    /:id/stats                → stats en tiempo real
 * POST   /preview-audience         → preview del tamaño de audiencia
 */

const campaignService = require('../../services/campaign.service')
const { workspaceParam, paginationQuery, errorResponse, security } = require('../../schemas/common')

// ── Schema reutilizable de respuesta ─────────────────────────────────────────

const CampaignStats = {
  type: 'object',
  properties: {
    total:     { type: 'number' },
    sent:      { type: 'number' },
    delivered: { type: 'number' },
    read:      { type: 'number' },
    replied:   { type: 'number' },
    failed:    { type: 'number' },
    opted_out: { type: 'number' },
    skipped:   { type: 'number' },
    sent_a:    { type: 'number' },
    replied_a: { type: 'number' },
    sent_b:    { type: 'number' },
    replied_b: { type: 'number' },
    conversations_created: { type: 'number' },
  },
}

const CampaignResponse = {
  type: 'object',
  properties: {
    _id:          { type: 'string' },
    workspace_id: { type: 'string' },
    name:         { type: 'string' },
    channel_id:   { type: 'string' },
    channel_type: { type: 'string' },
    type:         { type: 'string', enum: ['immediate', 'drip', 'trigger'] },
    status:       { type: 'string', enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled'] },
    audience:     { type: 'object' },
    template:     { type: 'object' },
    schedule:     { type: 'object' },
    drip_steps:   { type: 'array', items: { type: 'object' } },
    trigger:      { type: 'object' },
    utm:          { type: 'object' },
    stats:        CampaignStats,
    launched_at:  { type: ['string', 'null'], format: 'date-time' },
    completed_at: { type: ['string', 'null'], format: 'date-time' },
    createdAt:    { type: 'string', format: 'date-time' },
    updatedAt:    { type: 'string', format: 'date-time' },
  },
}

const idParam = {
  type: 'object',
  required: ['workspaceId', 'id'],
  properties: {
    workspaceId: { type: 'string' },
    id:          { type: 'string' },
  },
}

async function campaignRoutes(fastify) {
  const preHandler   = [fastify.authenticate, fastify.requireWorkspace]
  const adminHandler = [...preHandler, fastify.requireRole('admin')]

  // ── GET / — listar ────────────────────────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Campaigns'],
      summary: 'Listar campañas del workspace',
      security,
      params: workspaceParam,
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled'] },
          page:   { type: 'integer', default: 1, minimum: 1 },
          limit:  { type: 'integer', default: 20, minimum: 1, maximum: 100 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            campaigns: { type: 'array', items: CampaignResponse },
            total:     { type: 'number' },
            page:      { type: 'number' },
            limit:     { type: 'number' },
          },
        },
      },
    },
  }, async (request) => {
    const { status, page, limit } = request.query
    return campaignService.listCampaigns(request.workspaceId, { status, page, limit })
  })

  // ── POST / — crear ────────────────────────────────────────────────────────
  fastify.post('/', {
    preHandler: adminHandler,
    schema: {
      tags: ['Campaigns'],
      summary: 'Crear campaña (queda en borrador)',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['name', 'channel_id'],
        properties: {
          name:        { type: 'string', minLength: 1, maxLength: 120 },
          channel_id:  { type: 'string' },
          type:        { type: 'string', enum: ['immediate', 'drip', 'trigger'], default: 'immediate' },
          audience: {
            type: 'object',
            properties: {
              type:        { type: 'string', enum: ['all', 'segment', 'manual'] },
              filters:     { type: 'object' },
              contact_ids: { type: 'array', items: { type: 'string' } },
            },
          },
          template: {
            type: 'object',
            properties: {
              type:             { type: 'string', enum: ['text', 'hsm'] },
              content:          { type: 'string' },
              hsm_name:         { type: 'string' },
              hsm_language:     { type: 'string' },
              hsm_components:   { },
              subject:          { type: 'string' },
              content_b:        { type: 'string' },
              ab_test_enabled:  { type: 'boolean' },
              ab_split_percent: { type: 'number' },
            },
          },
          schedule: {
            type: 'object',
            properties: {
              send_at:       { type: 'string', format: 'date-time' },
              timezone:      { type: 'string' },
              allowed_hours: { type: 'object' },
              allowed_days:  { type: 'array', items: { type: 'number' } },
            },
          },
          drip_steps: {
            type: 'array',
            items: {
              type: 'object',
              required: ['delay_days'],
              properties: {
                delay_days: { type: 'number', minimum: 0 },
                template:   { type: 'object' },
              },
            },
          },
          trigger: {
            type: 'object',
            required: ['event'],
            properties: {
              event:           { type: 'string', enum: ['birthday', 'inactivity', 'cart_abandoned'] },
              inactivity_days: { type: 'number', minimum: 1 },
            },
          },
          utm: {
            type: 'object',
            properties: {
              source:   { type: 'string' },
              medium:   { type: 'string' },
              campaign: { type: 'string' },
            },
          },
        },
      },
      response: { 201: CampaignResponse, 404: errorResponse },
    },
  }, async (request, reply) => {
    const campaign = await campaignService.createCampaign(
      request.workspaceId,
      request.body,
      request.user?.sub
    )
    return reply.code(201).send(campaign)
  })

  // ── GET /:id ──────────────────────────────────────────────────────────────
  fastify.get('/:id', {
    preHandler,
    schema: {
      tags: ['Campaigns'],
      summary: 'Obtener campaña por ID',
      security,
      params: idParam,
      response: { 200: CampaignResponse, 404: errorResponse },
    },
  }, async (request) => {
    return campaignService.getCampaign(request.workspaceId, request.params.id)
  })

  // ── PUT /:id — actualizar (solo draft) ────────────────────────────────────
  fastify.put('/:id', {
    preHandler: adminHandler,
    schema: {
      tags: ['Campaigns'],
      summary: 'Actualizar campaña (solo borrador)',
      security,
      params: idParam,
      body: {
        type: 'object',
        properties: {
          name:       { type: 'string' },
          audience:   { type: 'object' },
          template:   { type: 'object' },
          schedule:   { type: 'object' },
          drip_steps: { type: 'array' },
          trigger:    { type: 'object' },
          utm:        { type: 'object' },
        },
      },
      response: { 200: CampaignResponse, 404: errorResponse, 409: errorResponse },
    },
  }, async (request) => {
    return campaignService.updateCampaign(request.workspaceId, request.params.id, request.body)
  })

  // ── DELETE /:id ───────────────────────────────────────────────────────────
  fastify.delete('/:id', {
    preHandler: adminHandler,
    schema: {
      tags: ['Campaigns'],
      summary: 'Eliminar campaña (solo borrador o cancelada)',
      security,
      params: idParam,
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        404: errorResponse,
        409: errorResponse,
      },
    },
  }, async (request) => {
    await campaignService.deleteCampaign(request.workspaceId, request.params.id)
    return { success: true }
  })

  // ── POST /:id/launch — lanzar ─────────────────────────────────────────────
  fastify.post('/:id/launch', {
    preHandler: adminHandler,
    schema: {
      tags: ['Campaigns'],
      summary: 'Lanzar campaña',
      description: 'Resuelve la audiencia, crea CampaignContacts y pone la campaña en running o scheduled.',
      security,
      params: idParam,
      response: { 200: CampaignResponse, 404: errorResponse, 409: errorResponse, 422: errorResponse },
    },
  }, async (request) => {
    return campaignService.launchCampaign(request.workspaceId, request.params.id)
  })

  // ── POST /:id/pause ───────────────────────────────────────────────────────
  fastify.post('/:id/pause', {
    preHandler: adminHandler,
    schema: {
      tags: ['Campaigns'],
      summary: 'Pausar campaña en ejecución',
      security,
      params: idParam,
      response: { 200: CampaignResponse, 404: errorResponse },
    },
  }, async (request) => {
    const campaign = await campaignService.pauseCampaign(request.workspaceId, request.params.id)
    if (!campaign) throw Object.assign(new Error('Campaña no encontrada o no está en ejecución'), { statusCode: 404 })
    return campaign
  })

  // ── POST /:id/cancel ──────────────────────────────────────────────────────
  fastify.post('/:id/cancel', {
    preHandler: adminHandler,
    schema: {
      tags: ['Campaigns'],
      summary: 'Cancelar campaña',
      security,
      params: idParam,
      response: { 200: CampaignResponse, 404: errorResponse, 409: errorResponse },
    },
  }, async (request) => {
    return campaignService.cancelCampaign(request.workspaceId, request.params.id)
  })

  // ── GET /:id/contacts — lista de contactos ────────────────────────────────
  fastify.get('/:id/contacts', {
    preHandler,
    schema: {
      tags: ['Campaigns'],
      summary: 'Lista de contactos de la campaña con estado por contacto',
      security,
      params: idParam,
      querystring: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'sent', 'delivered', 'read', 'replied', 'failed', 'opted_out', 'skipped'],
          },
          page:  { type: 'integer', default: 1, minimum: 1 },
          limit: { type: 'integer', default: 50, minimum: 1, maximum: 200 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            contacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
            total:    { type: 'number' },
            page:     { type: 'number' },
            limit:    { type: 'number' },
          },
        },
      },
    },
  }, async (request) => {
    const { status, page, limit } = request.query
    return campaignService.getCampaignContacts(
      request.workspaceId,
      request.params.id,
      { status, page, limit }
    )
  })

  // ── GET /:id/stats — stats en tiempo real ─────────────────────────────────
  fastify.get('/:id/stats', {
    preHandler,
    schema: {
      tags: ['Campaigns'],
      summary: 'Stats en tiempo real de una campaña',
      security,
      params: idParam,
      response: {
        200: {
          type: 'object',
          properties: {
            campaign_id: { type: 'string' },
            status:      { type: 'string' },
            stats:       CampaignStats,
            rates: {
              type: 'object',
              properties: {
                delivery_rate: { type: 'number' },
                read_rate:     { type: 'number' },
                reply_rate:    { type: 'number' },
                fail_rate:     { type: 'number' },
                opt_out_rate:  { type: 'number' },
              },
            },
          },
        },
        404: errorResponse,
      },
    },
  }, async (request) => {
    const campaign = await campaignService.getCampaign(request.workspaceId, request.params.id)
    const s = campaign.stats
    const base = s.sent || 1

    return {
      campaign_id: campaign._id,
      status:      campaign.status,
      stats:       s,
      rates: {
        delivery_rate: parseFloat(((s.delivered / base) * 100).toFixed(1)),
        read_rate:     parseFloat(((s.read      / base) * 100).toFixed(1)),
        reply_rate:    parseFloat(((s.replied   / base) * 100).toFixed(1)),
        fail_rate:     parseFloat(((s.failed    / s.total || 0) * 100).toFixed(1)),
        opt_out_rate:  parseFloat(((s.opted_out / s.total || 0) * 100).toFixed(1)),
      },
    }
  })

  // ── POST /preview-audience ────────────────────────────────────────────────
  fastify.post('/preview-audience', {
    preHandler,
    schema: {
      tags: ['Campaigns'],
      summary: 'Vista previa del tamaño de audiencia antes de lanzar',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['channel_id'],
        properties: {
          channel_id: { type: 'string' },
          audience:   { type: 'object' },
        },
      },
      response: {
        200: { type: 'object', properties: { count: { type: 'number' } } },
        404: errorResponse,
      },
    },
  }, async (request) => {
    return campaignService.previewAudience(request.workspaceId, request.body)
  })
}

module.exports = campaignRoutes
