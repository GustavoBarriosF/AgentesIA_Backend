'use strict'

const Lead = require('../../db/models/lead')
const { workspaceParam, paginationQuery, errorResponse, security } = require('../../schemas/common')

const LeadObject = {
  type: 'object',
  properties: {
    _id:             { type: 'string' },
    workspace_id:    { type: 'string' },
    contact_id: {
      type: 'object',
      description: 'Contacto populado (name, email, phone)',
      properties: {
        _id:   { type: 'string' },
        name:  { type: 'string' },
        email: { type: 'string', nullable: true },
        phone: { type: 'string', nullable: true },
      },
    },
    conversation_id: { type: 'string', nullable: true },
    assigned_to:     { type: 'string', nullable: true, description: 'Agent ID' },
    stage: {
      type: 'string',
      enum: ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'],
      description: 'Etapa del pipeline de ventas',
    },
    value:        { type: 'number', description: 'Valor estimado del lead', nullable: true },
    currency:     { type: 'string', default: 'USD', example: 'USD' },
    lost_reason:  { type: 'string', nullable: true },
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content:   { type: 'string' },
          author_id: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    custom_fields: { type: 'object' },
    tags:          { type: 'array', items: { type: 'string' } },
    createdAt:     { type: 'string', format: 'date-time' },
    updatedAt:     { type: 'string', format: 'date-time' },
  },
}

async function leadRoutes(fastify) {
  const preHandler = [fastify.authenticate, fastify.requireWorkspace]

  // ─── GET /api/:workspaceId/leads ──────────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Leads'],
      summary: 'Listar leads',
      description: 'Retorna leads paginados. Úsalos para construir un tablero Kanban del pipeline.',
      security,
      params: workspaceParam,
      querystring: {
        type: 'object',
        properties: {
          ...paginationQuery,
          stage: {
            type: 'string',
            enum: ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'],
            description: 'Filtrar por etapa',
          },
          assigned_to: { type: 'string', description: 'Filtrar por agente (Agent ID)' },
        },
      },
      response: {
        200: {
          description: 'Leads paginados',
          type: 'object',
          properties: {
            leads: { type: 'array', items: LeadObject },
            total: { type: 'integer' },
            page:  { type: 'integer' },
            limit: { type: 'integer' },
          },
        },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const { stage, assigned_to, page = 1, limit = 20 } = request.query
    const query = { workspace_id: request.workspaceId }
    if (stage) query.stage = stage
    if (assigned_to) query.assigned_to = assigned_to

    const skip = (page - 1) * limit
    const [leads, total] = await Promise.all([
      Lead.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit))
        .populate('contact_id', 'name email phone')
        .lean(),
      Lead.countDocuments(query),
    ])
    return { leads, total, page: Number(page), limit: Number(limit) }
  })

  // ─── POST /api/:workspaceId/leads ─────────────────────────────────────────
  fastify.post('/', {
    preHandler,
    schema: {
      tags: ['Leads'],
      summary: 'Crear lead',
      description: 'Registra un nuevo lead en el pipeline de ventas.',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['contact_id'],
        properties: {
          contact_id:      { type: 'string', description: 'ID del contacto' },
          conversation_id: { type: 'string', description: 'Conversación origen (opcional)' },
          stage:           { type: 'string', enum: ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'], default: 'new' },
          value:           { type: 'number', example: 5000 },
          currency:        { type: 'string', default: 'USD', example: 'USD' },
          tags:            { type: 'array', items: { type: 'string' } },
          custom_fields:   { type: 'object', example: { empresa: 'Acme', empleados: 50 } },
        },
      },
      response: {
        201: { description: 'Lead creado', ...LeadObject },
        400: { description: 'Datos inválidos', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const lead = await Lead.create({ workspace_id: request.workspaceId, ...request.body })
    return reply.code(201).send(lead)
  })

  // ─── PATCH /api/:workspaceId/leads/:leadId ────────────────────────────────
  fastify.patch('/:leadId', {
    preHandler,
    schema: {
      tags: ['Leads'],
      summary: 'Actualizar lead',
      description: 'Mueve el lead a otra etapa, actualiza valor o asigna a un agente.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'leadId'],
        properties: {
          workspaceId: { type: 'string' },
          leadId:      { type: 'string', description: 'ID del lead' },
        },
      },
      body: {
        type: 'object',
        properties: {
          stage:         { type: 'string', enum: ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'] },
          value:         { type: 'number' },
          lost_reason:   { type: 'string', description: 'Requerido si stage = lost', example: 'Precio muy alto' },
          assigned_to:   { type: 'string', description: 'Agent ID' },
          custom_fields: { type: 'object' },
        },
      },
      response: {
        200: { description: 'Lead actualizado', ...LeadObject },
        404: { description: 'Lead no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    return Lead.findOneAndUpdate(
      { _id: request.params.leadId, workspace_id: request.workspaceId },
      { $set: { ...request.body } },
      { new: true }
    )
  })

  // ─── POST /api/:workspaceId/leads/:leadId/notes ───────────────────────────
  fastify.post('/:leadId/notes', {
    preHandler,
    schema: {
      tags: ['Leads'],
      summary: 'Agregar nota al lead',
      description: 'Registra una nota interna del equipo comercial sobre el lead.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'leadId'],
        properties: {
          workspaceId: { type: 'string' },
          leadId:      { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', example: 'Llamada realizada, interesado en plan Pro. Seguimiento en 3 días.' },
        },
      },
      response: {
        200: { description: 'Nota agregada — retorna el lead completo', ...LeadObject },
        404: { description: 'Lead no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    return Lead.findOneAndUpdate(
      { _id: request.params.leadId, workspace_id: request.workspaceId },
      { $push: { notes: { content: request.body.content, author_id: request.user.sub } } },
      { new: true }
    )
  })
}

module.exports = leadRoutes
