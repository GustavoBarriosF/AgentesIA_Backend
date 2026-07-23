'use strict'

/**
 * campaign.service.js
 *
 * Orquestador de campañas de marketing multicanal.
 *
 * Tipos de campaña:
 *   immediate  → envío único, inmediato o en fecha programada
 *   drip       → secuencia de mensajes separados por días
 *   trigger    → disparada por evento (inactividad, cumpleaños)
 *
 * Canales soportados:
 *   whatsapp, whatsapp_baileys, telegram, email, facebook_messenger
 *
 * Flujo:
 *   1. createCampaign()  → status=draft
 *   2. launchCampaign()  → resuelve audiencia, crea CampaignContacts, status=running/scheduled
 *   3. campaign-processor.job → procesa CampaignContacts en lotes con rate limiting
 *   4. handleDeliveryWebhook() → actualiza delivered/read por channel_message_id
 *   5. handleOptOut()    → marca contacto como opted_out
 */

const Campaign        = require('../db/models/campaign')
const CampaignContact = require('../db/models/campaign-contact')
const Contact         = require('../db/models/contact')
const Channel         = require('../db/models/channel')
const axios           = require('axios')
const logger          = require('../utils/logger')

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v19.0'
const GRAPH_BASE    = `https://graph.facebook.com/${GRAPH_VERSION}`

// Palabras clave de opt-out (insensible a mayúsculas/tildes)
const OPT_OUT_KEYWORDS = ['stop', 'baja', 'cancelar', 'desuscribir', 'unsubscribe', 'no más', 'no mas']

// Rate limits por canal (ms entre envíos)
const SEND_DELAY_MS = {
  whatsapp:           800,
  telegram:           300,
  email:              200,
  facebook_messenger: 800,
  instagram_dm:       800,
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

async function createCampaign(workspaceId, data, userId) {
  const channel = await Channel.findOne({
    _id:          data.channel_id,
    workspace_id: workspaceId,
    active:       true,
  }).lean()

  if (!channel) {
    const err = new Error('Canal no encontrado o inactivo')
    err.statusCode = 404
    throw err
  }

  const SUPPORTED_CAMPAIGN_CHANNELS = ['whatsapp', 'whatsapp_baileys', 'telegram', 'email', 'facebook_messenger', 'instagram_dm']
  if (!SUPPORTED_CAMPAIGN_CHANNELS.includes(channel.type)) {
    const err = new Error(`El canal de tipo "${channel.type}" no soporta campañas`)
    err.statusCode = 422
    throw err
  }

  return Campaign.create({
    workspace_id: workspaceId,
    channel_type: channel.type,
    created_by:   userId || null,
    ...data,
  })
}

async function updateCampaign(workspaceId, campaignId, data) {
  const campaign = await Campaign.findOne({ _id: campaignId, workspace_id: workspaceId })
  if (!campaign) throw Object.assign(new Error('Campaña no encontrada'), { statusCode: 404 })
  if (!['draft'].includes(campaign.status)) {
    throw Object.assign(new Error('Solo se pueden editar campañas en borrador'), { statusCode: 409 })
  }
  Object.assign(campaign, data)
  return campaign.save()
}

async function deleteCampaign(workspaceId, campaignId) {
  const campaign = await Campaign.findOne({ _id: campaignId, workspace_id: workspaceId })
  if (!campaign) throw Object.assign(new Error('Campaña no encontrada'), { statusCode: 404 })
  if (!['draft', 'cancelled'].includes(campaign.status)) {
    throw Object.assign(new Error('Solo se pueden eliminar campañas en borrador o canceladas'), { statusCode: 409 })
  }
  await CampaignContact.deleteMany({ campaign_id: campaignId })
  await campaign.deleteOne()
}

async function listCampaigns(workspaceId, { status, page = 1, limit = 20 } = {}) {
  const query = { workspace_id: workspaceId }
  if (status) query.status = status
  const skip = (page - 1) * limit
  const [campaigns, total] = await Promise.all([
    Campaign.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Campaign.countDocuments(query),
  ])
  return { campaigns, total, page, limit }
}

async function getCampaign(workspaceId, campaignId) {
  const campaign = await Campaign.findOne({ _id: campaignId, workspace_id: workspaceId }).lean()
  if (!campaign) throw Object.assign(new Error('Campaña no encontrada'), { statusCode: 404 })
  return campaign
}

// ─── Audiencia ────────────────────────────────────────────────────────────────

/**
 * Resuelve la audiencia de una campaña y devuelve los contactos elegibles.
 * Excluye siempre los que hicieron opt-out.
 */
async function resolveAudience(workspaceId, audience, channelType) {
  const query = {
    workspace_id:        workspaceId,
    campaign_opted_out:  { $ne: true },
  }

  // Filtrar por canal del contacto (solo contactos con ese channel_type tienen channel_ref válido)
  if (channelType === 'whatsapp') {
    query.channel_type = { $in: ['whatsapp', 'whatsapp_baileys'] }
  } else if (channelType && channelType !== 'email') {
    query.channel_type = channelType
  }

  if (audience.type === 'manual' && audience.contact_ids?.length) {
    query._id = { $in: audience.contact_ids }
  } else if (audience.type === 'segment') {
    const f = audience.filters || {}
    if (f.channel_type) query.channel_type = f.channel_type
    if (f.has_phone === true)  query.phone  = { $nin: [null, ''] }
    if (f.has_phone === false) query.phone  = { $in:  [null, ''] }
    if (f.has_email === true)  query.email  = { $nin: [null, ''] }
    if (f.has_email === false) query.email  = { $in:  [null, ''] }
    if (f.created_after)  query.createdAt = { ...query.createdAt, $gte: new Date(f.created_after)  }
    if (f.created_before) query.createdAt = { ...query.createdAt, $lte: new Date(f.created_before) }
    if (f.tags?.length)   query['custom_fields.tags'] = { $in: f.tags }
  }
  // audience.type === 'all': sin filtros extra (ya filtra por workspace y opt-out)

  // Para WhatsApp/Telegram solo contactos con phone
  if (['whatsapp', 'whatsapp_baileys', 'telegram'].includes(channelType)) {
    query.phone = query.phone || { $nin: [null, ''] }
  }
  // Para email solo contactos con email
  if (channelType === 'email') {
    query.email = { $nin: [null, ''] }
  }

  return Contact.find(query).select('_id name email phone channel_ref channel_type custom_fields').lean()
}

/**
 * Preview de audiencia: devuelve count sin lanzar la campaña.
 */
async function previewAudience(workspaceId, { audience, channel_id }) {
  const channel = await Channel.findOne({ _id: channel_id, workspace_id: workspaceId }).lean()
  if (!channel) throw Object.assign(new Error('Canal no encontrado'), { statusCode: 404 })
  const contacts = await resolveAudience(workspaceId, audience || {}, channel.type)
  return { count: contacts.length }
}

// ─── Lanzamiento ──────────────────────────────────────────────────────────────

/**
 * Lanza una campaña:
 *   1. Resuelve audiencia → crea CampaignContact (pending) por cada contacto
 *   2. Actualiza stats.total y status
 *   3. Si tiene fecha futura → 'scheduled', si no → 'running'
 */
async function launchCampaign(workspaceId, campaignId) {
  const campaign = await Campaign.findOne({ _id: campaignId, workspace_id: workspaceId })
  if (!campaign) throw Object.assign(new Error('Campaña no encontrada'), { statusCode: 404 })
  if (!['draft', 'paused'].includes(campaign.status)) {
    throw Object.assign(new Error(`No se puede lanzar una campaña en estado "${campaign.status}"`), { statusCode: 409 })
  }

  // Resolver audiencia
  const contacts = await resolveAudience(workspaceId, campaign.audience, campaign.channel_type)
  if (!contacts.length) {
    throw Object.assign(new Error('La audiencia está vacía — no hay contactos elegibles'), { statusCode: 422 })
  }

  // Crear CampaignContacts (ignorar duplicados si ya existen del lanzamiento anterior pausado)
  const abEnabled = campaign.template?.ab_test_enabled
  const splitPct  = campaign.template?.ab_split_percent ?? 50

  const docs = contacts.map((c, idx) => {
    let variant = null
    if (abEnabled) variant = (idx / contacts.length * 100) < splitPct ? 'a' : 'b'
    return {
      campaign_id:  campaign._id,
      workspace_id: workspaceId,
      contact_id:   c._id,
      variant,
      drip_step:    0,
      status:       'pending',
    }
  })

  // insertMany con ordered:false para ignorar el unique index si ya existen
  try {
    await CampaignContact.insertMany(docs, { ordered: false })
  } catch (err) {
    if (err.code !== 11000) throw err // ignorar duplicate key, lanzar el resto
  }

  const total = await CampaignContact.countDocuments({ campaign_id: campaign._id, drip_step: 0 })

  const sendAt = campaign.schedule?.send_at
  const isScheduled = sendAt && new Date(sendAt) > new Date()

  campaign.status      = isScheduled ? 'scheduled' : 'running'
  campaign.launched_at = new Date()
  campaign._job_offset = 0
  campaign.audience.total_count = total
  campaign.stats.total = total
  await campaign.save()

  logger.info({ campaignId, total, status: campaign.status }, '[Campaign] Lanzada')
  return campaign
}

async function pauseCampaign(workspaceId, campaignId) {
  return Campaign.findOneAndUpdate(
    { _id: campaignId, workspace_id: workspaceId, status: 'running' },
    { status: 'paused' },
    { new: true }
  )
}

async function cancelCampaign(workspaceId, campaignId) {
  const campaign = await Campaign.findOneAndUpdate(
    { _id: campaignId, workspace_id: workspaceId, status: { $in: ['draft', 'scheduled', 'running', 'paused'] } },
    { status: 'cancelled', completed_at: new Date() },
    { new: true }
  )
  if (!campaign) throw Object.assign(new Error('Campaña no encontrada o no se puede cancelar'), { statusCode: 409 })
  return campaign
}

// ─── Envío por canal ──────────────────────────────────────────────────────────

/**
 * Envía el mensaje de la campaña a un contacto.
 * Devuelve el channel_message_id si el canal lo provee.
 */
async function sendToContact(campaign, campaignContact, contact, channel) {
  const template = campaign.template
  const isB      = campaignContact.variant === 'b'
  const content  = (isB && template.content_b) ? template.content_b : template.content

  // Interpolación de variables {{nombre}}, {{empresa}}
  const rendered = interpolate(content, contact)

  switch (campaign.channel_type) {
    case 'whatsapp':
      return sendWhatsAppCampaign(channel.config, contact, rendered, template)

    case 'telegram':
      return sendTelegramCampaign(channel.config, contact.channel_ref, rendered)

    case 'facebook_messenger':
    case 'instagram_dm':
      return sendMetaCampaign(channel.config, contact.channel_ref, rendered)

    case 'email':
      return sendEmailCampaign(channel.config, contact, rendered, template.subject)

    default:
      throw new Error(`Canal no soportado para campañas: ${campaign.channel_type}`)
  }
}

function interpolate(text, contact) {
  if (!text) return ''
  return text
    .replace(/\{\{nombre\}\}/gi, contact.name || '')
    .replace(/\{\{email\}\}/gi, contact.email || '')
    .replace(/\{\{telefono\}\}/gi, contact.phone || '')
    .replace(/\{\{empresa\}\}/gi, contact.custom_fields?.company || '')
}

async function sendWhatsAppCampaign(config, contact, text, template) {
  const { phone_number_id, access_token } = config
  const url = `${GRAPH_BASE}/${phone_number_id}/messages`

  let body
  if (template.type === 'hsm' && template.hsm_name) {
    // Plantilla HSM aprobada por Meta
    body = {
      messaging_product: 'whatsapp',
      to:   contact.phone,
      type: 'template',
      template: {
        name:       template.hsm_name,
        language:   { code: template.hsm_language || 'es_CO' },
        components: template.hsm_components || [],
      },
    }
  } else {
    body = {
      messaging_product: 'whatsapp',
      to:   contact.phone,
      type: 'text',
      text: { body: text, preview_url: false },
    }
  }

  const res = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    timeout: 10_000,
  })
  // WhatsApp devuelve messages[0].id
  return res.data?.messages?.[0]?.id || null
}

async function sendTelegramCampaign(config, chatId, text) {
  const { bot_token } = config
  const url = `https://api.telegram.org/bot${bot_token}/sendMessage`
  const res = await axios.post(url, { chat_id: chatId, text, parse_mode: 'Markdown' }, { timeout: 10_000 })
  return res.data?.result?.message_id?.toString() || null
}

async function sendMetaCampaign(config, recipientId, text) {
  const { access_token } = config
  const res = await axios.post(`${GRAPH_BASE}/me/messages`,
    { recipient: { id: recipientId }, message: { text }, messaging_type: 'MESSAGE_TAG', tag: 'CONFIRMED_EVENT_UPDATE' },
    { params: { access_token }, headers: { 'Content-Type': 'application/json' }, timeout: 10_000 }
  )
  return res.data?.message_id || null
}

async function sendEmailCampaign(config, contact, text, subject) {
  const emailService = require('./email.service')
  await emailService.sendEmailReply(config, {
    to:      contact.email,
    toName:  contact.name || '',
    subject: subject || 'Mensaje de nuestro equipo',
    text,
  })
  return null // Email no devuelve ID de mensaje externo
}

// ─── Procesamiento por lotes (llamado por el job) ─────────────────────────────

const MAX_ATTEMPTS = 3
const BATCH_SIZE   = 50

/**
 * Procesa un lote de CampaignContacts pendientes para una campaña.
 * Respeta el rate limiting del canal.
 * Devuelve true si la campaña se completó.
 */
async function processBatch(campaign) {
  const channel = await Channel.findById(campaign.channel_id).lean()
  if (!channel) {
    logger.error({ campaignId: campaign._id }, '[Campaign] Canal no encontrado, cancelando')
    campaign.status = 'cancelled'
    await campaign.save()
    return true
  }

  const delay = SEND_DELAY_MS[campaign.channel_type] || 500

  const pendingContacts = await CampaignContact.find({
    campaign_id: campaign._id,
    drip_step:   0, // solo paso 0 para immediate; los drip se gestionan aparte
    status:      'pending',
    attempts:    { $lt: MAX_ATTEMPTS },
  })
    .limit(BATCH_SIZE)
    .lean()

  if (!pendingContacts.length) {
    // Verificar si quedan failed con reintentos
    const remaining = await CampaignContact.countDocuments({
      campaign_id: campaign._id,
      status:      { $in: ['pending', 'sent'] },
    })
    if (remaining === 0) {
      campaign.status       = 'completed'
      campaign.completed_at = new Date()
      await campaign.save()
      logger.info({ campaignId: campaign._id }, '[Campaign] Completada')
      return true
    }
    return false
  }

  for (const cc of pendingContacts) {
    const contact = await Contact.findById(cc.contact_id).lean()

    if (!contact || contact.campaign_opted_out) {
      await CampaignContact.findByIdAndUpdate(cc._id, { status: 'skipped' })
      await Campaign.findByIdAndUpdate(campaign._id, { $inc: { 'stats.skipped': 1 } })
      continue
    }

    try {
      const msgId = await sendToContact(campaign, cc, contact, channel)

      await CampaignContact.findByIdAndUpdate(cc._id, {
        status:             'sent',
        sent_at:            new Date(),
        channel_message_id: msgId || null,
        attempts:           cc.attempts + 1,
      })

      const statInc = { 'stats.sent': 1 }
      if (cc.variant === 'a') statInc['stats.sent_a'] = 1
      if (cc.variant === 'b') statInc['stats.sent_b'] = 1
      await Campaign.findByIdAndUpdate(campaign._id, { $inc: statInc })

    } catch (err) {
      const attempts = cc.attempts + 1
      const newStatus = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'

      await CampaignContact.findByIdAndUpdate(cc._id, {
        status:        newStatus,
        attempts,
        failed_reason: err.message?.slice(0, 200),
      })

      if (newStatus === 'failed') {
        await Campaign.findByIdAndUpdate(campaign._id, { $inc: { 'stats.failed': 1 } })
      }

      logger.warn({ campaignId: campaign._id, contactId: cc.contact_id, err: err.message }, '[Campaign] Error enviando mensaje')
    }

    // Rate limiting
    await sleep(delay)
  }

  return false
}

/**
 * Verifica si alguna campaña drip tiene pasos pendientes de enviar.
 * Llamado por el job cada minuto.
 */
async function processDripSteps() {
  const campaigns = await Campaign.find({
    type:   'drip',
    status: 'running',
  }).lean()

  for (const campaign of campaigns) {
    for (let step = 0; step < campaign.drip_steps.length; step++) {
      const dripStep  = campaign.drip_steps[step]
      const delayMs   = dripStep.delay_days * 24 * 3600 * 1000
      const sendAfter = new Date(campaign.launched_at.getTime() + delayMs)

      if (new Date() < sendAfter) continue // aún no es tiempo de este paso

      // Buscar contactos del paso anterior que ya enviaron y este paso está pending
      const pending = await CampaignContact.find({
        campaign_id: campaign._id,
        drip_step:   step,
        status:      'pending',
      }).limit(BATCH_SIZE).lean()

      if (!pending.length) continue

      const channel = await Channel.findById(campaign.channel_id).lean()
      if (!channel) continue

      const delay = SEND_DELAY_MS[campaign.channel_type] || 500

      for (const cc of pending) {
        const contact = await Contact.findById(cc.contact_id).lean()
        if (!contact || contact.campaign_opted_out) {
          await CampaignContact.findByIdAndUpdate(cc._id, { status: 'skipped' })
          continue
        }

        // Usar template del paso drip
        const stepTemplate = { ...campaign.template, ...dripStep.template }
        const fakeCampaign = { ...campaign, template: stepTemplate }

        try {
          const msgId = await sendToContact(fakeCampaign, cc, contact, channel)
          await CampaignContact.findByIdAndUpdate(cc._id, {
            status:  'sent',
            sent_at: new Date(),
            channel_message_id: msgId || null,
          })
          await Campaign.findByIdAndUpdate(campaign._id, { $inc: { 'stats.sent': 1 } })
        } catch (err) {
          await CampaignContact.findByIdAndUpdate(cc._id, {
            status:        'failed',
            failed_reason: err.message?.slice(0, 200),
          })
          await Campaign.findByIdAndUpdate(campaign._id, { $inc: { 'stats.failed': 1 } })
        }

        await sleep(delay)
      }
    }
  }
}

// ─── Opt-out ──────────────────────────────────────────────────────────────────

/**
 * Detecta si el mensaje entrante es una palabra clave de opt-out.
 */
function isOptOutMessage(text) {
  if (!text) return false
  const normalized = text.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar tildes
  return OPT_OUT_KEYWORDS.some(kw => normalized === kw || normalized.startsWith(kw + ' '))
}

/**
 * Registra el opt-out del contacto y actualiza stats de campañas activas.
 */
async function handleOptOut(workspaceId, contactId) {
  await Contact.findByIdAndUpdate(contactId, {
    campaign_opted_out:    true,
    campaign_opted_out_at: new Date(),
  })

  // Marcar como opted_out en campañas en curso
  const updated = await CampaignContact.updateMany(
    { workspace_id: workspaceId, contact_id: contactId, status: 'pending' },
    { status: 'opted_out' }
  )

  // Actualizar stats de las campañas afectadas
  if (updated.modifiedCount > 0) {
    const affected = await CampaignContact.distinct('campaign_id', {
      workspace_id: workspaceId,
      contact_id:   contactId,
      status:       'opted_out',
    })
    for (const campaignId of affected) {
      await Campaign.findByIdAndUpdate(campaignId, { $inc: { 'stats.opted_out': 1 } })
    }
  }

  logger.info({ workspaceId, contactId }, '[Campaign] Opt-out registrado')
}

// ─── Webhook de entrega (WhatsApp status updates) ─────────────────────────────

/**
 * Actualiza el estado de entrega/lectura de un mensaje de campaña
 * cuando llega el webhook de WhatsApp con status updates.
 *
 * @param {string} channelMessageId  ID del mensaje en WhatsApp
 * @param {'delivered'|'read'} status
 */
async function handleDeliveryWebhook(channelMessageId, status) {
  const cc = await CampaignContact.findOne({ channel_message_id: channelMessageId }).lean()
  if (!cc) return // no es un mensaje de campaña

  const updateFields = {}
  if (status === 'delivered' && !cc.delivered_at) {
    updateFields.status       = 'delivered'
    updateFields.delivered_at = new Date()
    await CampaignContact.findByIdAndUpdate(cc._id, updateFields)
    await Campaign.findByIdAndUpdate(cc.campaign_id, { $inc: { 'stats.delivered': 1 } })
  } else if (status === 'read' && !cc.read_at) {
    updateFields.status  = 'read'
    updateFields.read_at = new Date()
    await CampaignContact.findByIdAndUpdate(cc._id, updateFields)
    await Campaign.findByIdAndUpdate(cc.campaign_id, { $inc: { 'stats.read': 1 } })
  }
}

/**
 * Verifica si el contacto recibió un mensaje de campaña en los últimos 7 días.
 * Retorna la campaña asociada (con reply_behavior) o null.
 */
async function checkCampaignReply(workspaceId, contactId) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000)
  const cc = await CampaignContact.findOne({
    workspace_id: workspaceId,
    contact_id:   contactId,
    status:       { $in: ['sent', 'delivered', 'read'] },
    sent_at:      { $gte: sevenDaysAgo },
  }).sort({ sent_at: -1 }).lean()

  if (!cc) return null

  const campaign = await Campaign.findById(cc.campaign_id).lean()
  if (!campaign) return null

  return campaign  // incluye campaign.reply_behavior
}

/**
 * Registra una respuesta del contacto a un mensaje de campaña.
 * Llamado desde el webhook de mensajes entrantes.
 */
async function handleReply(workspaceId, contactId, messageText) {
  // Verificar opt-out
  if (isOptOutMessage(messageText)) {
    await handleOptOut(workspaceId, contactId)
    return { optOut: true }
  }

  // Marcar como replied en la campaña más reciente que tenga un mensaje enviado
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000)
  const cc = await CampaignContact.findOne({
    workspace_id: workspaceId,
    contact_id:   contactId,
    status:       { $in: ['sent', 'delivered', 'read'] },
    sent_at:      { $gte: sevenDaysAgo },
  }).sort({ sent_at: -1 }).lean()

  if (!cc) return { optOut: false, campaign: null }

  await CampaignContact.findByIdAndUpdate(cc._id, { status: 'replied', replied_at: new Date() })
  const statInc = { 'stats.replied': 1 }
  if (cc.variant === 'a') statInc['stats.replied_a'] = 1
  if (cc.variant === 'b') statInc['stats.replied_b'] = 1
  await Campaign.findByIdAndUpdate(cc.campaign_id, { $inc: statInc })

  const campaignDoc = await Campaign.findById(cc.campaign_id).lean()
  return { optOut: false, campaign: campaignDoc }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

async function getCampaignContacts(workspaceId, campaignId, { status, page = 1, limit = 50 } = {}) {
  const query = { campaign_id: campaignId, workspace_id: workspaceId }
  if (status) query.status = status
  const skip = (page - 1) * limit

  const [contacts, total] = await Promise.all([
    CampaignContact.find(query)
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .populate('contact_id', 'name email phone')
      .lean(),
    CampaignContact.countDocuments(query),
  ])
  return { contacts, total, page, limit }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  createCampaign,
  updateCampaign,
  deleteCampaign,
  listCampaigns,
  getCampaign,
  launchCampaign,
  pauseCampaign,
  cancelCampaign,
  previewAudience,
  processBatch,
  processDripSteps,
  handleOptOut,
  handleReply,
  checkCampaignReply,
  handleDeliveryWebhook,
  getCampaignContacts,
  isOptOutMessage,
}
