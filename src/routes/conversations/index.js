'use strict'

const convService       = require('../../services/conversation.service')
const Agent             = require('../../db/models/agent')
const User              = require('../../db/models/user')
const WorkspaceMember   = require('../../db/models/workspace-member')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

const ConversationObject = {
  type: 'object',
  properties: {
    _id:                  { type: 'string' },
    workspace_id:         { type: 'string' },
    contact_id:           { type: 'object', description: 'Contacto populado', additionalProperties: true },
    channel_id:           { type: 'object', description: 'Canal populado', additionalProperties: true },
    agent_id:             { type: 'object', description: 'Agente asignado (populado)', nullable: true, additionalProperties: true },
    status:               { type: 'string', enum: ['open', 'bot', 'pending', 'assigned', 'resolved', 'abandoned'] },
    handled_by:           { type: 'string', enum: ['bot', 'agent', 'hybrid'], nullable: true },
    bot_turns:            { type: 'integer' },
    first_response_time_s:{ type: 'integer', nullable: true },
    resolution_time_s:    { type: 'integer', nullable: true },
    resolved_at:          { type: 'string', format: 'date-time', nullable: true },
    csat_score:           { type: 'integer', minimum: 1, maximum: 5, nullable: true },
    tags:                 { type: 'array', items: { type: 'string' } },
    last_message_at:      { type: 'string', format: 'date-time', nullable: true },
    createdAt:            { type: 'string', format: 'date-time' },
  },
}

async function conversationRoutes(fastify) {
  const preHandler = [fastify.authenticate, fastify.requireWorkspace]

  // ─── GET /api/:workspaceId/conversations ──────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Conversations'],
      summary: 'Listar conversaciones',
      description: 'Retorna conversaciones paginadas con cursor. Soporta múltiples filtros.',
      security,
      params: workspaceParam,
      querystring: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['open', 'bot', 'pending', 'assigned', 'resolved', 'abandoned'],
            description: 'Filtrar por estado',
          },
          agent_id:   { type: 'string', description: 'Filtrar por agente asignado' },
          channel_id: { type: 'string', description: 'Filtrar por canal' },
          from:       { type: 'string', format: 'date-time', description: 'Fecha de inicio (ISO 8601)' },
          to:         { type: 'string', format: 'date-time', description: 'Fecha de fin (ISO 8601)' },
          cursor:      { type: 'string', description: 'Cursor para paginación (ID del último elemento)' },
          limit:       { type: 'integer', default: 20, minimum: 1, maximum: 100 },
          active_only: { type: 'boolean', default: false, description: 'Excluir resueltas y abandonadas' },
        },
      },
      response: {
        200: {
          description: 'Lista de conversaciones',
          type: 'object',
          properties: {
            conversations: { type: 'array', items: ConversationObject },
            next_cursor:   { type: 'string', nullable: true, description: 'Cursor para la siguiente página' },
            total:         { type: 'integer' },
          },
        },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const { status, agent_id, channel_id, from, to, cursor, limit, active_only } = request.query
    const userId = request.user.sub

    // Verificar el rol directamente en DB para evitar tokens desactualizados
    const membership = await WorkspaceMember.findOne({
      workspace_id: request.workspaceId,
      user_id:      userId,
      active:       true,
    }).lean()

    const currentRole = membership?.role ?? request.workspaceRole

    let apply_visibility    = false
    let visible_to_agent_id = null
    let visible_to_dept_id  = null
    let dept_unassigned_only = false

    if (currentRole === 'owner') {
      // owner → ve todas las conversaciones sin restricción
    } else if (currentRole === 'admin') {
      if (membership?.department_id) {
        // admin con departamento → ve TODAS las conversaciones de su departamento
        apply_visibility   = true
        visible_to_dept_id = membership.department_id
      }
      // admin sin departamento → ve todo sin restricción
    } else {
      // agent o viewer → filtrado estricto
      apply_visibility     = true
      dept_unassigned_only = true
      const agentProfile = await Agent.findOne({ workspace_id: request.workspaceId, user_id: userId }).lean()
      visible_to_agent_id = agentProfile?._id ?? null
      visible_to_dept_id  = membership?.department_id ?? null
    }

    return convService.listConversations(request.workspaceId, {
      status, active_only, agent_id, channel_id, from, to, cursor, limit,
      apply_visibility, visible_to_agent_id, visible_to_dept_id, dept_unassigned_only,
    })
  })

  // ─── GET /api/:workspaceId/conversations/:convId ──────────────────────────
  fastify.get('/:convId', {
    preHandler,
    schema: {
      tags: ['Conversations'],
      summary: 'Obtener conversación',
      description: 'Retorna el detalle completo de una conversación con contacto, canal y agente populados.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'convId'],
        properties: {
          workspaceId: { type: 'string' },
          convId:      { type: 'string', description: 'ID de la conversación' },
        },
      },
      response: {
        200: { description: 'Conversación encontrada', ...ConversationObject },
        404: { description: 'No encontrada', ...errorResponse },
      },
    },
  }, async (request) => {
    return convService.getConversation(request.workspaceId, request.params.convId)
  })

  // ─── POST /api/:workspaceId/conversations/:convId/assign ──────────────────
  fastify.post('/:convId/assign', {
    preHandler,
    schema: {
      tags: ['Conversations'],
      summary: 'Asignar conversación a agente',
      description: 'Asigna la conversación a un agente. Cambia el status a `assigned`.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'convId'],
        properties: { workspaceId: { type: 'string' }, convId: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', description: 'ID del agente a asignar' },
        },
      },
      response: {
        200: { description: 'Conversación asignada', ...ConversationObject },
        404: { description: 'Conversación o agente no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    const conv = await convService.assignConversation(request.workspaceId, request.params.convId, request.body.agent_id)
    fastify.io?.to(`workspace:${request.workspaceId}`).emit('conversation:updated', { id: conv._id, status: conv.status, agent_id: conv.agent_id })
    // Notificar al widget quién atenderá
    try {
      const agent = await Agent.findById(request.body.agent_id).lean()
      const user = agent?.user_id ? await User.findById(agent.user_id).select('name').lean() : null
      const agentName = user?.name || 'Agente'
      fastify.widgetIo?.to(`conv:${request.params.convId}`).emit('conversation:assigned', { agent_name: agentName })
    } catch {}
    return conv
  })

  // ─── POST /api/:workspaceId/conversations/:convId/assign-department ──────
  fastify.post('/:convId/assign-department', {
    preHandler,
    schema: {
      tags: ['Conversations'],
      summary: 'Asignar conversación a departamento',
      description: 'Mueve la conversación a un departamento sin asignarla a un agente específico. Status → pending.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'convId'],
        properties: { workspaceId: { type: 'string' }, convId: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['department_id'],
        properties: {
          department_id: { type: 'string', description: 'ID del departamento' },
        },
      },
      response: {
        200: { description: 'Conversación asignada a departamento', ...ConversationObject },
        404: { description: 'Conversación no encontrada', ...errorResponse },
      },
    },
  }, async (request) => {
    await convService.escalateToQueue(request.workspaceId, request.params.convId, {
      assignedDepartmentId: request.body.department_id,
    })
    const conv = await convService.getConversation(request.workspaceId, request.params.convId)
    fastify.io?.to(`workspace:${request.workspaceId}`).emit('conversation:updated', {
      id: conv._id, status: conv.status, department_id: request.body.department_id,
    })
    return conv
  })

  // ─── POST /api/:workspaceId/conversations/:convId/resolve ─────────────────
  fastify.post('/:convId/resolve', {
    preHandler,
    schema: {
      tags: ['Conversations'],
      summary: 'Resolver conversación',
      description: 'Marca la conversación como resuelta y registra el tiempo de resolución.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'convId'],
        properties: { workspaceId: { type: 'string' }, convId: { type: 'string' } },
      },
      response: {
        200: { description: 'Conversación resuelta', ...ConversationObject },
        404: { description: 'No encontrada', ...errorResponse },
      },
    },
  }, async (request) => {
    const conv = await convService.resolveConversation(request.workspaceId, request.params.convId)
    fastify.io?.to(`conv:${request.params.convId}`).emit('conversation:resolved', { id: conv._id })
    fastify.widgetIo?.to(`conv:${request.params.convId}`).emit('conversation:resolved', { id: conv._id })
    return conv
  })

  // ─── POST /api/:workspaceId/conversations/:convId/reopen ──────────────────
  fastify.post('/:convId/reopen', {
    preHandler,
    schema: {
      tags: ['Conversations'],
      summary: 'Reabrir conversación',
      description: 'Cambia el status de `resolved` o `abandoned` a `open`.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'convId'],
        properties: { workspaceId: { type: 'string' }, convId: { type: 'string' } },
      },
      response: {
        200: { description: 'Conversación reabierta', ...ConversationObject },
        404: { description: 'No encontrada', ...errorResponse },
      },
    },
  }, async (request) => {
    return convService.reopenConversation(request.workspaceId, request.params.convId)
  })

  // ─── POST /api/:workspaceId/conversations/:convId/transfer ────────────────
  fastify.post('/:convId/transfer', {
    preHandler,
    schema: {
      tags: ['Conversations'],
      summary: 'Transferir a otro agente',
      description: 'Reasigna la conversación a un agente diferente y emite evento WebSocket.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'convId'],
        properties: { workspaceId: { type: 'string' }, convId: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['agent_id'],
        properties: {
          agent_id: { type: 'string', description: 'ID del nuevo agente' },
        },
      },
      response: {
        200: { description: 'Conversación transferida', ...ConversationObject },
        404: { description: 'Conversación o agente no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    const conv = await convService.transferConversation(request.workspaceId, request.params.convId, request.body.agent_id)
    fastify.io?.to(`workspace:${request.workspaceId}`).emit('conversation:transferred', { id: conv._id, agent_id: conv.agent_id })
    return conv
  })

  // ─── DELETE /api/:workspaceId/conversations/:convId ──────────────────────
  fastify.delete('/:convId', {
    preHandler,
    schema: {
      tags: ['Conversations'],
      summary: 'Eliminar conversación',
      description: 'Elimina la conversación y todos sus mensajes permanentemente.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'convId'],
        properties: { workspaceId: { type: 'string' }, convId: { type: 'string' } },
      },
      response: {
        200: { description: 'Conversación eliminada', type: 'object', properties: { ok: { type: 'boolean' } } },
        404: { description: 'No encontrada', ...errorResponse },
      },
    },
  }, async (request) => {
    await convService.deleteConversation(request.workspaceId, request.params.convId)
    fastify.io?.to(`workspace:${request.workspaceId}`).emit('conversation:deleted', { id: request.params.convId })
    return { ok: true }
  })

  // ─── POST /api/:workspaceId/conversations/:convId/csat ────────────────────
  fastify.post('/:convId/csat', {
    preHandler,
    schema: {
      tags: ['Conversations'],
      summary: 'Registrar CSAT (satisfacción del cliente)',
      description: 'Guarda la puntuación de satisfacción (1-5 ⭐) y comentario opcional. Normalmente se llama desde el widget del cliente.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'convId'],
        properties: { workspaceId: { type: 'string' }, convId: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['score'],
        properties: {
          score:   { type: 'integer', minimum: 1, maximum: 5, description: '1 = muy insatisfecho, 5 = muy satisfecho' },
          comment: { type: 'string', maxLength: 500, description: 'Comentario opcional del cliente' },
        },
      },
      response: {
        200: { description: 'CSAT registrado', ...ConversationObject },
        404: { description: 'Conversación no encontrada', ...errorResponse },
      },
    },
  }, async (request) => {
    return convService.saveCsat(request.workspaceId, request.params.convId, request.body)
  })
}

module.exports = conversationRoutes
