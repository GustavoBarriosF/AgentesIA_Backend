'use strict'

const cron = require('node-cron')
const Ticket = require('../db/models/ticket')
const Plan = require('../db/models/plan')
const logger = require('../utils/logger')

const SLA_HOURS = { free: 48, starter: 24, pro: 8, enterprise: 4 }

async function checkSLABreaches() {
  logger.debug('Job SLA: revisando tickets...')

  // Obtener todos los planes y sus limites de SLA
  const plans = await Plan.find({}).lean()
  const slaByWorkspace = {}
  for (const plan of plans) {
    slaByWorkspace[plan.workspace_id.toString()] = SLA_HOURS[plan.tier] || 48
  }

  const now = new Date()

  for (const [workspaceId, hours] of Object.entries(slaByWorkspace)) {
    const cutoff = new Date(now.getTime() - hours * 3600 * 1000)

    const breached = await Ticket.find({
      workspace_id: workspaceId,
      status: { $in: ['open', 'in_progress'] },
      sla_breach: false,
      createdAt: { $lte: cutoff },
    })

    for (const ticket of breached) {
      ticket.sla_breach = true
      await ticket.save()
      logger.info({ ticketId: ticket._id, workspaceId }, 'Ticket marcado como SLA breach')
      // TODO: enviar notificacion al agente y admin
    }
  }
}

function startSLAMonitor() {
  // Cada 5 minutos
  cron.schedule('*/5 * * * *', () => {
    checkSLABreaches().catch(err => logger.error({ err }, 'Error en job SLA monitor'))
  })
  logger.info('Job SLA monitor iniciado (cada 5 min)')
}

module.exports = { startSLAMonitor }
