'use strict'

const agentService = require('../../services/agent.service')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

const AgentObject = {
  type: 'object',
  properties: {
    _id:          { type: 'string' },
    workspace_id: { type: 'string' },
    user_id: {
      type: 'object',
      properties: {
        _id:        { type: 'string' },
        name:       { type: 'string' },
        email:      { type: 'string' },
        avatar_url: { type: 'string', nullable: true },
      },
    },
    status:       { type: 'string', enum: ['online', 'away', 'offline'] },
    skills:       { type: 'array', items: { type: 'string' }, description: 'Tags de habilidades para routing' },
    max_chats:    { type: 'integer', description: 'Máximo de chats simultáneos' },
    active_chats: { type: 'integer', description: 'Conversaciones activas actualmente' },
    active:       { type: 'boolean' },
  },
}

async function agentRoutes(fastify) {
  const preHandler  = [fastify.authenticate, fastify.requireWorkspace]
  const adminHandler = [...preHandler, fastify.requireRole('admin')]

  // ─── GET /api/:workspaceId/agents ─────────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Agents'],
      summary: 'Listar agentes',
      description: 'Retorna todos los agentes del workspace con su estado de disponibilidad.',
      security,
      params: workspaceParam,
      response: {
        200: { description: 'Lista de agentes', type: 'array', items: AgentObject },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    return agentService.listAgents(request.workspaceId)
  })

  // ─── GET /api/:workspaceId/agents/:agentId ────────────────────────────────
  fastify.get('/:agentId', {
    preHandler,
    schema: {
      tags: ['Agents'],
      summary: 'Obtener agente',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'agentId'],
        properties: {
          workspaceId: { type: 'string' },
          agentId:     { type: 'string', description: 'ID del agente' },
        },
      },
      response: {
        200: { description: 'Agente encontrado', ...AgentObject },
        404: { description: 'Agente no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    return agentService.getAgent(request.workspaceId, request.params.agentId)
  })

  // ─── PATCH /api/:workspaceId/agents/:agentId ──────────────────────────────
  fastify.patch('/:agentId', {
    preHandler: adminHandler,
    schema: {
      tags: ['Agents'],
      summary: 'Actualizar agente',
      description: 'Modifica habilidades o límite de chats simultáneos. **Requiere rol admin.**',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'agentId'],
        properties: {
          workspaceId: { type: 'string' },
          agentId:     { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          skills:    { type: 'array', items: { type: 'string' }, example: ['ventas', 'soporte'] },
          max_chats: { type: 'integer', minimum: 1, maximum: 50, example: 5 },
          active:    { type: 'boolean' },
        },
      },
      response: {
        200: { description: 'Agente actualizado', ...AgentObject },
        403: { description: 'Se requiere rol admin', ...errorResponse },
        404: { description: 'Agente no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    return agentService.updateAgent(request.workspaceId, request.params.agentId, request.body)
  })

  // ─── POST /api/:workspaceId/agents/:agentId/status ────────────────────────
  fastify.post('/:agentId/status', {
    preHandler,
    schema: {
      tags: ['Agents'],
      summary: 'Cambiar estado de disponibilidad',
      description: 'El agente actualiza su propio estado. Afecta al routing automático de conversaciones.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'agentId'],
        properties: {
          workspaceId: { type: 'string' },
          agentId:     { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['status'],
        properties: {
          status: {
            type: 'string',
            enum: ['online', 'away', 'offline'],
            description: '`online` = disponible, `away` = no recibe nuevos chats, `offline` = desconectado',
          },
        },
      },
      response: {
        200: { description: 'Estado actualizado', ...AgentObject },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    return agentService.setAgentStatus(request.workspaceId, request.params.agentId, request.body.status)
  })
}

module.exports = agentRoutes
