'use strict'

const cron = require('node-cron')
const Conversation = require('../db/models/conversation')
const logger = require('../utils/logger')

const ABANDONED_AFTER_HOURS = 4

async function markAbandonedConversations({ widgetIo, io } = {}) {
  logger.debug('Job abandoned: revisando conversaciones inactivas...')
  const cutoff = new Date(Date.now() - ABANDONED_AFTER_HOURS * 3600 * 1000)

  // Buscar individualmente para poder emitir eventos por conversación
  const conversations = await Conversation.find(
    {
      status: { $in: ['bot', 'pending', 'open', 'assigned'] },
      last_message_at: { $lte: cutoff },
    },
    { _id: 1, workspace_id: 1 }
  ).lean()

  if (conversations.length === 0) return

  const ids = conversations.map(c => c._id)
  await Conversation.updateMany(
    { _id: { $in: ids } },
    { $set: { status: 'abandoned' } }
  )

  logger.info({ count: conversations.length }, 'Conversaciones marcadas como abandonadas')

  // Notificar al widget y al dashboard por cada conversación
  for (const conv of conversations) {
    const convId = conv._id.toString()
    const wsId   = conv.workspace_id?.toString()

    if (widgetIo) {
      widgetIo.to(`conv:${convId}`).emit('conversation:resolved', { id: convId })
    }
    if (io && wsId) {
      io.to(`workspace:${wsId}`).emit('conversation:resolved', { id: convId })
    }
  }
}

function startAbandonedJob(opts = {}) {
  // Cada hora
  cron.schedule('0 * * * *', () => {
    markAbandonedConversations(opts).catch(err =>
      logger.error({ err }, 'Error en job abandoned conversations')
    )
  })
  logger.info('Job abandoned conversations iniciado (cada hora)')
}

module.exports = { startAbandonedJob }
