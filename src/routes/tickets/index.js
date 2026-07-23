'use strict'

const Ticket    = require('../../db/models/ticket')
const Contact   = require('../../db/models/contact')
const Workspace = require('../../db/models/workspace')
const mailer    = require('../../services/mailer.service')
const logger    = require('../../utils/logger')
const { workspaceParam, paginationQuery, errorResponse, security } = require('../../schemas/common')

const TicketObject = {
  type: 'object',
  properties: {
    _id:          { type: 'string' },
    workspace_id: { type: 'string' },
    contact_id:   { type: 'object', description: 'Contacto populado (name, email)' },
    conversation_id: { type: 'string', nullable: true },
    assigned_to:  { type: 'object', description: 'Agente asignado (populado)', nullable: true },
    department_id: { type: 'object', description: 'Departamento asignado (populado)', nullable: true },
    title:        { type: 'string' },
    description:  { type: 'string', nullable: true },
    priority:     { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    status:       { type: 'string', enum: ['open', 'in_progress', 'waiting', 'resolved', 'closed'] },
    sla_breach:   { type: 'boolean' },
    sla_due_at:   { type: 'string', format: 'date-time', nullable: true },
    resolved_at:  { type: 'string', format: 'date-time', nullable: true },
    internal_notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content:    { type: 'string' },
          author_id:  { type: 'string' },
          createdAt:  { type: 'string', format: 'date-time' },
        },
      },
    },
    public_notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content:    { type: 'string' },
          author_id:  { type: 'string' },
          createdAt:  { type: 'string', format: 'date-time' },
        },
      },
    },
    tags:      { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

async function ticketRoutes(fastify) {
  const preHandler = [fastify.authenticate, fastify.requireWorkspace]

  // ─── GET /api/:workspaceId/tickets ────────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Tickets'],
      summary: 'Listar tickets',
      description: 'Retorna tickets paginados con filtros opcionales.',
      security,
      params: workspaceParam,
      querystring: {
        type: 'object',
        properties: {
          ...paginationQuery,
          status: {
            type: 'string',
            enum: ['open', 'in_progress', 'waiting', 'resolved', 'closed'],
            description: 'Filtrar por estado',
          },
          priority: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'urgent'],
            description: 'Filtrar por prioridad',
          },
          assigned_to: { type: 'string', description: 'Filtrar por agente (Agent ID)' },
          department_id: { type: 'string', description: 'Filtrar por departamento (Department ID)' },
        },
      },
      response: {
        200: {
          description: 'Tickets paginados',
          type: 'object',
          properties: {
            tickets: { type: 'array', items: TicketObject },
            total:   { type: 'integer' },
            page:    { type: 'integer' },
            limit:   { type: 'integer' },
          },
        },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const { status, priority, assigned_to, department_id, page = 1, limit = 20 } = request.query
    const query = { workspace_id: request.workspaceId }
    if (status) query.status = status
    if (priority) query.priority = priority
    if (assigned_to) query.assigned_to = assigned_to
    if (department_id) query.department_id = department_id

    const skip = (page - 1) * limit
    const [tickets, total] = await Promise.all([
      Ticket.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit))
        .populate('contact_id', 'name email')
        .populate({ path: 'assigned_to', populate: { path: 'user_id', select: 'name' } })
        .populate('department_id', 'name color')
        .lean(),
      Ticket.countDocuments(query),
    ])
    return { tickets, total, page: Number(page), limit: Number(limit) }
  })

  // ─── POST /api/:workspaceId/tickets ───────────────────────────────────────
  fastify.post('/', {
    preHandler,
    schema: {
      tags: ['Tickets'],
      summary: 'Crear ticket',
      description: 'Crea un nuevo ticket de soporte, opcionalmente vinculado a una conversación.',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['title', 'contact_id'],
        properties: {
          title:           { type: 'string', example: 'Problema con el pago' },
          description:     { type: 'string', example: 'El cliente no puede completar el checkout con tarjeta Visa' },
          contact_id:      { type: 'string', description: 'ID del contacto' },
          conversation_id: { type: 'string', description: 'Conversación origen (opcional)' },
          priority:        { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
          tags:            { type: 'array', items: { type: 'string' }, example: ['pago', 'checkout'] },
          department_id:   { type: 'string', description: 'Departamento al que se asigna el ticket (opcional)' },
        },
      },
      response: {
        201: { description: 'Ticket creado', ...TicketObject },
        400: { description: 'Datos inválidos', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const ticket = await Ticket.create({ workspace_id: request.workspaceId, ...request.body })
    return reply.code(201).send(ticket)
  })

  // ─── GET /api/:workspaceId/tickets/:ticketId ──────────────────────────────
  fastify.get('/:ticketId', {
    preHandler,
    schema: {
      tags: ['Tickets'],
      summary: 'Obtener ticket',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'ticketId'],
        properties: {
          workspaceId: { type: 'string' },
          ticketId:    { type: 'string', description: 'ID del ticket' },
        },
      },
      response: {
        200: { description: 'Ticket encontrado', ...TicketObject },
        404: { description: 'Ticket no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    const ticket = await Ticket.findOne({ _id: request.params.ticketId, workspace_id: request.workspaceId })
      .populate('contact_id')
      .populate('department_id', 'name color')
      .lean()
    if (!ticket) return request.server.httpErrors?.notFound?.() || { error: 'No encontrado' }
    return ticket
  })

  // ─── PATCH /api/:workspaceId/tickets/:ticketId ────────────────────────────
  fastify.patch('/:ticketId', {
    preHandler,
    schema: {
      tags: ['Tickets'],
      summary: 'Actualizar ticket',
      description: 'Modifica estado, prioridad, asignación o descripción. Si `status` es `resolved`, se registra `resolved_at` automáticamente.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'ticketId'],
        properties: {
          workspaceId: { type: 'string' },
          ticketId:    { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          title:       { type: 'string' },
          description: { type: 'string' },
          status:      { type: 'string', enum: ['open', 'in_progress', 'waiting', 'resolved', 'closed'] },
          priority:    { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          assigned_to: { type: 'string', description: 'Agent ID' },
          tags:        { type: 'array', items: { type: 'string' } },
          department_id: { type: ['string', 'null'], description: 'Department ID o null para quitar' },
        },
      },
      response: {
        200: { description: 'Ticket actualizado', ...TicketObject },
        404: { description: 'Ticket no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    const allowed = ['status', 'priority', 'assigned_to', 'department_id', 'title', 'description', 'tags']
    const update = {}
    for (const k of allowed) {
      if (request.body[k] !== undefined) update[k] = request.body[k]
    }
    if (update.status === 'resolved') update.resolved_at = new Date()

    // Buscar estado anterior solo si va a cambiar
    const oldTicket = update.status
      ? await Ticket.findOne({ _id: request.params.ticketId, workspace_id: request.workspaceId })
          .select('status contact_id title').lean()
      : null

    const ticket = await Ticket.findOneAndUpdate(
      { _id: request.params.ticketId, workspace_id: request.workspaceId },
      { $set: update },
      { new: true }
    ).populate('contact_id', 'name email').populate('department_id', 'name color').lean()

    // Enviar email si el estado cambió y el contacto tiene email
    if (
      oldTicket &&
      update.status &&
      update.status !== oldTicket.status &&
      ticket?.contact_id?.email
    ) {
      const ticketShortId = ticket._id.toString().slice(-8).toUpperCase()
      const contactName   = ticket.contact_id.name && ticket.contact_id.name !== 'Visitante'
        ? ticket.contact_id.name : null
      const workspace = await Workspace.findById(request.workspaceId).select('name').lean()
      mailer.sendTicketStatusChange({
        to:           ticket.contact_id.email,
        name:         contactName,
        ticketId:     ticketShortId,
        title:        ticket.title,
        oldStatus:    oldTicket.status,
        newStatus:    update.status,
        workspaceName: workspace?.name || null,
      }).catch((err) => logger.warn({ err: err.message, to: ticket.contact_id.email }, '[Tickets] No se pudo enviar email de cambio de estado'))
    }

    return ticket
  })

  // ─── POST /api/:workspaceId/tickets/:ticketId/notes ───────────────────────
  fastify.post('/:ticketId/notes', {
    preHandler,
    schema: {
      tags: ['Tickets'],
      summary: 'Agregar nota interna',
      description: 'Las notas internas son visibles solo para el equipo, no para el cliente.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'ticketId'],
        properties: {
          workspaceId: { type: 'string' },
          ticketId:    { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', example: 'El cliente ya fue contactado por teléfono, espera confirmación del equipo de pagos.' },
        },
      },
      response: {
        200: { description: 'Nota agregada — retorna el ticket completo', ...TicketObject },
        404: { description: 'Ticket no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    return Ticket.findOneAndUpdate(
      { _id: request.params.ticketId, workspace_id: request.workspaceId },
      { $push: { internal_notes: { content: request.body.content, author_id: request.user.sub } } },
      { new: true }
    )
  })

  // ─── POST /api/:workspaceId/tickets/:ticketId/public-notes ────────────────
  fastify.post('/:ticketId/public-notes', {
    preHandler,
    schema: {
      tags: ['Tickets'],
      summary: 'Agregar nota pública',
      description: 'Las notas públicas son visibles para el cliente (se pueden enviar por email).',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'ticketId'],
        properties: {
          workspaceId: { type: 'string' },
          ticketId:    { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', example: 'Ya revisamos tu caso. Estamos procesando el reembolso, llegará en 3-5 días hábiles.' },
        },
      },
      response: {
        200: { description: 'Nota pública agregada — retorna el ticket completo', ...TicketObject },
        404: { description: 'Ticket no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    const { content } = request.body

    const ticket = await Ticket.findOneAndUpdate(
      { _id: request.params.ticketId, workspace_id: request.workspaceId },
      { $push: { public_notes: { content, author_id: request.user.sub } } },
      { new: true }
    ).populate('contact_id', 'name email').lean()

    if (!ticket) return request.server.httpErrors?.notFound?.() || { error: 'No encontrado' }

    // Enviar notificación al cliente si tiene email
    const contact = ticket.contact_id
    if (contact?.email) {
      const ticketShortId  = ticket._id.toString().slice(-8).toUpperCase()
      const contactName    = contact.name && contact.name !== 'Visitante' ? contact.name : null
      const workspace      = await Workspace.findById(request.workspaceId).select('name').lean()
      mailer.sendTicketUpdate({
        to:            contact.email,
        name:          contactName,
        ticketId:      ticketShortId,
        title:         ticket.title,
        noteContent:   content,
        workspaceName: workspace?.name || null,
      }).catch((err) => logger.warn({ err: err.message, to: contact.email }, '[Tickets] No se pudo enviar email de actualización'))
    }

    return ticket
  })
}

module.exports = ticketRoutes
