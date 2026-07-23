'use strict'

const cron = require('node-cron')
const Plan = require('../db/models/plan')
const logger = require('../utils/logger')

async function resetMonthlyUsage() {
  logger.info('Job usage-reset: reseteando contadores mensuales...')
  const result = await Plan.updateMany(
    { status: { $in: ['active', 'trialing'] } },
    {
      $set: {
        'usage.conversations_this_month': 0,
        'usage.period_start': new Date(),
      },
    }
  )
  logger.info({ count: result.modifiedCount }, 'Contadores mensuales reseteados')
}

function startUsageResetJob() {
  // Primer dia de cada mes a las 00:01
  cron.schedule('1 0 1 * *', () => {
    resetMonthlyUsage().catch(err => logger.error({ err }, 'Error en job usage reset'))
  })
  logger.info('Job usage reset iniciado (1ro de cada mes)')
}

module.exports = { startUsageResetJob }
