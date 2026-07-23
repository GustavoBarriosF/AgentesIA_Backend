'use strict'

const cron = require('node-cron')
const { getRedis } = require('../db/redis')
const Workspace = require('../db/models/workspace')
const agentService = require('../services/agent.service')
const logger = require('../utils/logger')

async function processAllQueues() {
  const redis = getRedis()
  const keys = await redis.keys('queue:*')

  for (const key of keys) {
    const workspaceId = key.replace('queue:', '')
    const queueLen = await redis.llen(key)
    if (queueLen === 0) continue

    const workspace = await Workspace.findById(workspaceId).lean()
    if (!workspace?.active) continue

    await agentService.processQueue(workspaceId)
  }
}

function startQueueProcessor() {
  // Cada 30 segundos
  cron.schedule('*/30 * * * * *', () => {
    processAllQueues().catch(err => logger.error({ err }, 'Error en job queue processor'))
  })
  logger.info('Job queue processor iniciado (cada 30 seg)')
}

module.exports = { startQueueProcessor }
