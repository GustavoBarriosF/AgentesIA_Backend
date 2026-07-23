'use strict'

const baileysService = require('../services/baileys.service')
const Channel        = require('../db/models/channel')
const logger         = require('../utils/logger')

async function baileysRoutes(fastify) {
  // GET /api/:workspaceId/channels/:channelId/baileys/status
  fastify.get('/:channelId/baileys/status', {
    schema: {
      tags: ['Canales - WhatsApp Baileys'],
      summary: 'Estado de conexión WhatsApp (Baileys)',
      description: 'Retorna el estado actual de la conexión y el QR (si está pendiente de escanear).',
      params: {
        type: 'object',
        required: ['workspaceId', 'channelId'],
        properties: {
          workspaceId: { type: 'string' },
          channelId:   { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['disconnected', 'connecting', 'reconnecting', 'qr_ready', 'connected'] },
            qr:     { type: 'string', nullable: true, description: 'QR como data URL (PNG base64), disponible cuando status=qr_ready' },
            phone:  { type: 'string', nullable: true, description: 'Número conectado, disponible cuando status=connected' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { workspaceId, channelId } = request.params

    // Verificar que el canal pertenece al workspace
    const channel = await Channel.findOne({ _id: channelId, workspace_id: workspaceId, type: 'whatsapp_baileys' }).lean()
    if (!channel) return reply.code(404).send({ error: 'Canal no encontrado' })

    return baileysService.getStatus(channelId)
  })

  // POST /api/:workspaceId/channels/:channelId/baileys/connect
  fastify.post('/:channelId/baileys/connect', {
    schema: {
      tags: ['Canales - WhatsApp Baileys'],
      summary: 'Iniciar conexión WhatsApp (Baileys)',
      description: [
        'Inicia la conexión con WhatsApp Web usando Baileys.',
        'Si no hay sesión guardada, genera un QR que se emite via WebSocket (`baileys:qr`) y',
        'también queda disponible en `GET /baileys/status`.',
        '',
        '⚠️ Canal NO OFICIAL — puede ser bloqueado por WhatsApp sin previo aviso.',
      ].join('\n'),
      params: {
        type: 'object',
        required: ['workspaceId', 'channelId'],
        properties: {
          workspaceId: { type: 'string' },
          channelId:   { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            message: { type: 'string' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { workspaceId, channelId } = request.params

    const channel = await Channel.findOne({ _id: channelId, workspace_id: workspaceId, type: 'whatsapp_baileys' }).lean()
    if (!channel) return reply.code(404).send({ error: 'Canal no encontrado' })

    try {
      const result = await baileysService.connect(channelId, workspaceId)
      return { status: result.status, message: 'Conexión iniciada — espera el QR o la confirmación de conexión.' }
    } catch (err) {
      logger.error({ err: err.message, channelId }, '[Baileys API] Error conectando')
      return reply.code(500).send({ error: 'Error al iniciar la conexión: ' + err.message })
    }
  })

  // DELETE /api/:workspaceId/channels/:channelId/baileys/disconnect
  fastify.delete('/:channelId/baileys/disconnect', {
    schema: {
      tags: ['Canales - WhatsApp Baileys'],
      summary: 'Desconectar WhatsApp (Baileys)',
      description: 'Cierra la sesión de WhatsApp Web y elimina la sesión guardada. Se requerirá un nuevo QR para reconectar.',
      params: {
        type: 'object',
        required: ['workspaceId', 'channelId'],
        properties: {
          workspaceId: { type: 'string' },
          channelId:   { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
        },
      },
    },
  }, async (request, reply) => {
    const { workspaceId, channelId } = request.params

    const channel = await Channel.findOne({ _id: channelId, workspace_id: workspaceId, type: 'whatsapp_baileys' }).lean()
    if (!channel) return reply.code(404).send({ error: 'Canal no encontrado' })

    try {
      await baileysService.disconnect(channelId)
      return { ok: true }
    } catch (err) {
      logger.error({ err: err.message, channelId }, '[Baileys API] Error desconectando')
      return reply.code(500).send({ error: 'Error al desconectar: ' + err.message })
    }
  })
}

module.exports = baileysRoutes
