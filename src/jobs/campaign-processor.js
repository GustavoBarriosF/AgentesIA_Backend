'use strict'

/**
 * campaign-processor.job.js
 *
 * Cron que corre cada minuto y procesa campañas activas:
 *   1. Mueve campañas 'scheduled' cuya send_at ya pasó → 'running'
 *   2. Procesa un lote de CampaignContacts pending por cada campaña 'running'
 *   3. Procesa pasos drip pendientes
 *   4. Dispara campañas trigger (inactividad, cumpleaños)
 *
 * Solo procesa una campaña por ejecución del cron para no bloquear el event loop.
 * Las campañas se turnan en cada tick (round-robin por _job_offset).
 */

const cron = require('node-cron')
const Campaign        = require('../db/models/campaign')
const CampaignContact = require('../db/models/campaign-contact')
const Contact         = require('../db/models/contact')
const campaignService = require('../services/campaign.service')
const logger          = require('../utils/logger')

// ─── Activar campañas programadas ─────────────────────────────────────────────

async function activateScheduledCampaigns() {
  const now = new Date()
  const scheduled = await Campaign.find({
    status:              'scheduled',
    'schedule.send_at':  { $lte: now },
  }).lean()

  for (const campaign of scheduled) {
    await Campaign.findByIdAndUpdate(campaign._id, { status: 'running' })
    logger.info({ campaignId: campaign._id }, '[CampaignJob] Campaña activada por schedule')
  }
}

// ─── Procesar campañas running ─────────────────────────────────────────────────

async function processRunningCampaigns() {
  const campaigns = await Campaign.find({ status: 'running', type: 'immediate' })
    .sort({ launched_at: 1 }) // las más antiguas primero
    .limit(3) // máx 3 campañas por tick
    .lean()

  for (const campaign of campaigns) {
    try {
      const completed = await campaignService.processBatch(campaign)
      if (completed) {
        logger.info({ campaignId: campaign._id }, '[CampaignJob] Campaña completada')
      }
    } catch (err) {
      logger.error({ err: err.message, campaignId: campaign._id }, '[CampaignJob] Error procesando campaña')
    }
  }
}

// ─── Campañas trigger: inactividad ────────────────────────────────────────────

async function processTriggerCampaigns() {
  const campaigns = await Campaign.find({
    type:   'trigger',
    status: 'running',
  }).lean()

  for (const campaign of campaigns) {
    if (campaign.trigger?.event !== 'inactivity') continue

    const inactivityDays = campaign.trigger.inactivity_days || 30
    const cutoff = new Date(Date.now() - inactivityDays * 24 * 3600 * 1000)

    // Contactos inactivos que aún no han recibido esta campaña
    const alreadySent = await CampaignContact.distinct('contact_id', { campaign_id: campaign._id })

    const inactiveContacts = await Contact.find({
      workspace_id:       campaign.workspace_id,
      campaign_opted_out: { $ne: true },
      last_seen:          { $lte: cutoff },
      _id:                { $nin: alreadySent },
    }).limit(50).lean()

    if (!inactiveContacts.length) continue

    const docs = inactiveContacts.map(c => ({
      campaign_id:  campaign._id,
      workspace_id: campaign.workspace_id,
      contact_id:   c._id,
      status:       'pending',
    }))

    try {
      await CampaignContact.insertMany(docs, { ordered: false })
      await Campaign.findByIdAndUpdate(campaign._id, {
        $inc: { 'stats.total': docs.length, 'audience.total_count': docs.length },
      })
    } catch (err) {
      if (err.code !== 11000) logger.error({ err: err.message }, '[CampaignJob] Error trigger inactivity')
    }
  }
}

// ─── Campañas trigger: cumpleaños ─────────────────────────────────────────────

async function processBirthdayCampaigns() {
  const campaigns = await Campaign.find({
    type:   'trigger',
    status: 'running',
    'trigger.event': 'birthday',
  }).lean()

  for (const campaign of campaigns) {
    const today = new Date()
    const mm = String(today.getMonth() + 1).padStart(2, '0')
    const dd = String(today.getDate()).padStart(2, '0')

    const alreadySentToday = await CampaignContact.distinct('contact_id', {
      campaign_id: campaign._id,
      sent_at:     { $gte: new Date(today.setHours(0, 0, 0, 0)) },
    })

    // Buscar contactos con cumpleaños hoy (campo custom_fields.birthday en formato MM-DD o YYYY-MM-DD)
    const contacts = await Contact.find({
      workspace_id:       campaign.workspace_id,
      campaign_opted_out: { $ne: true },
      $or: [
        { 'custom_fields.birthday': { $regex: `-${mm}-${dd}$` } },
        { 'custom_fields.birthday': `${mm}-${dd}` },
      ],
      _id: { $nin: alreadySentToday },
    }).limit(50).lean()

    if (!contacts.length) continue

    const docs = contacts.map(c => ({
      campaign_id:  campaign._id,
      workspace_id: campaign.workspace_id,
      contact_id:   c._id,
      status:       'pending',
    }))

    try {
      await CampaignContact.insertMany(docs, { ordered: false })
    } catch (err) {
      if (err.code !== 11000) logger.error({ err: err.message }, '[CampaignJob] Error trigger birthday')
    }
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function runCampaignProcessor() {
  try {
    await activateScheduledCampaigns()
    await processRunningCampaigns()
    await campaignService.processDripSteps()
    await processTriggerCampaigns()
    await processBirthdayCampaigns()
  } catch (err) {
    logger.error({ err: err.message }, '[CampaignJob] Error general en el procesador')
  }
}

function startCampaignProcessor() {
  // Cada minuto
  cron.schedule('* * * * *', () => {
    runCampaignProcessor().catch(err =>
      logger.error({ err }, '[CampaignJob] Error no capturado')
    )
  })
  logger.info('Job campaign-processor iniciado (cada 1 min)')
}

module.exports = { startCampaignProcessor, runCampaignProcessor }
