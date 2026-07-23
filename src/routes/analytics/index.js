'use strict'

const analyticsService = require('../../services/analytics.service')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

async function analyticsRoutes(fastify) {
  const preHandler = [fastify.authenticate, fastify.requireWorkspace]

  // ─── GET /api/:workspaceId/analytics/overview ─────────────────────────────
  fastify.get('/overview', {
    preHandler,
    schema: {
      tags: ['Analytics'],
      summary: 'Resumen de métricas',
      description: [
        'Retorna métricas agregadas del workspace para el período indicado:',
        '',
        '- Total de conversaciones y distribución por status',
        '- Tiempo promedio de primera respuesta y resolución',
        '- Score CSAT promedio',
        '- Mensajes enviados / recibidos',
        '- Conversaciones por canal',
        '- Performance por agente',
        '- Tasa de escalada bot → agente',
      ].join('\n'),
      security,
      params: workspaceParam,
      querystring: {
        type: 'object',
        properties: {
          from: {
            type: 'string',
            format: 'date-time',
            description: 'Inicio del período (ISO 8601)',
            example: '2026-03-01T00:00:00Z',
          },
          to: {
            type: 'string',
            format: 'date-time',
            description: 'Fin del período (ISO 8601)',
            example: '2026-03-31T23:59:59Z',
          },
        },
      },
      response: {
        200: {
          description: 'Métricas del período',
          type: 'object',
          properties: {
            total_conversations:         { type: 'integer' },
            by_status: {
              type: 'object',
              properties: {
                open:      { type: 'integer' },
                resolved:  { type: 'integer' },
                abandoned: { type: 'integer' },
              },
            },
            avg_first_response_time_s:   { type: 'number', description: 'Segundos promedio hasta primera respuesta' },
            avg_resolution_time_s:       { type: 'number', description: 'Segundos promedio hasta resolución' },
            avg_csat_score:              { type: 'number', description: 'CSAT promedio (1-5)' },
            total_messages:              { type: 'integer' },
            bot_escalation_rate:         { type: 'number', description: 'Porcentaje escalado a agente (0-1)' },
            by_channel: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  channel_id:   { type: 'string' },
                  channel_name: { type: 'string' },
                  type:         { type: 'string' },
                  count:        { type: 'integer' },
                },
              },
            },
            by_agent: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  agent_id:         { type: 'string' },
                  agent_name:       { type: 'string' },
                  conversations:    { type: 'integer' },
                  avg_resolution_s: { type: 'number' },
                  csat_avg:         { type: 'number' },
                },
              },
            },
          },
        },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const { from, to } = request.query
    return analyticsService.getOverview(request.workspaceId, { from, to })
  })

  // ─── GET /api/:workspaceId/analytics/token-usage ──────────────────────────
  fastify.get('/token-usage', {
    preHandler,
    schema: {
      tags: ['Analytics'],
      summary: 'Uso de tokens IA',
      security,
      params: workspaceParam,
      querystring: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date-time' },
          to:   { type: 'string', format: 'date-time' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            total_input_tokens:          { type: 'integer' },
            total_output_tokens:         { type: 'integer' },
            total_tokens:                { type: 'integer' },
            conversations_with_ai:       { type: 'integer' },
            avg_input_tokens_per_conv:   { type: 'integer' },
            avg_output_tokens_per_conv:  { type: 'integer' },
            avg_total_tokens_per_conv:   { type: 'integer' },
            by_model: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  model:              { type: 'string' },
                  input_tokens:       { type: 'integer' },
                  output_tokens:      { type: 'integer' },
                  total_tokens:       { type: 'integer' },
                  message_count:      { type: 'integer' },
                  avg_input_per_msg:  { type: 'integer' },
                  avg_output_per_msg: { type: 'integer' },
                },
              },
            },
          },
        },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const { from, to } = request.query
    return analyticsService.getTokenUsage(request.workspaceId, { from, to })
  })
}

module.exports = analyticsRoutes
