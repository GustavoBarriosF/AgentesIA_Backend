'use strict'

/**
 * meta.service.js
 *
 * Servicio para la Messenger Platform API de Meta.
 * Cubre Facebook Messenger e Instagram DM.
 *
 * Cada canal almacena sus credenciales en channel.config:
 *
 *   facebook_messenger:
 *     page_id        ID de la Página de Facebook
 *     access_token   Page Access Token (permanente)
 *     app_secret     App Secret para verificación HMAC
 *     verify_token   Token único para verificar el webhook en Meta
 *
 *   instagram_dm:
 *     ig_account_id  ID de la cuenta de Instagram conectada
 *     page_id        ID de la Página de Facebook vinculada (requerida para envíos)
 *     access_token   Page Access Token de la página vinculada
 *     app_secret     App Secret para verificación HMAC
 *     verify_token   Token único para verificar el webhook en Meta
 *
 * Nota: Para Instagram DM el envío usa el mismo endpoint que Messenger
 * (/me/messages) pero con el recipient = IGSID del usuario.
 */

const axios  = require('axios')
const logger = require('../utils/logger')

const GRAPH_VERSION = process.env.META_GRAPH_API_VERSION || 'v19.0'
const GRAPH_BASE    = `https://graph.facebook.com/${GRAPH_VERSION}`

// ─── Envío de mensajes ────────────────────────────────────────────────────────

/**
 * Envía un mensaje de texto a través de Messenger o Instagram DM.
 * El endpoint es el mismo para ambos canales — la diferencia está en el
 * access_token (page token) y el recipient ID (PSID o IGSID).
 *
 * @param {object} config    channel.config del canal
 * @param {string} recipientId  PSID (Messenger) o IGSID (Instagram)
 * @param {object} message   Objeto mensaje con al menos { content: string }
 */
async function sendMetaMessage(config, recipientId, message) {
  const { access_token } = config

  const body = {
    recipient:       { id: recipientId },
    message:         { text: message.content },
    messaging_type:  'RESPONSE',
  }

  try {
    const res = await axios.post(`${GRAPH_BASE}/me/messages`, body, {
      params:  { access_token },
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
    })
    return res.data
  } catch (err) {
    const errData = err.response?.data?.error
    logger.error({ errData, recipientId }, '[Meta] Error enviando mensaje')
    throw Object.assign(
      new Error(errData?.message || 'Error enviando mensaje Meta'),
      { statusCode: 502, metaError: errData }
    )
  }
}

/**
 * Envía un mensaje con respuestas rápidas (quick replies).
 * Útil para ofrecer opciones al usuario desde el bot.
 *
 * @param {object} config
 * @param {string} recipientId
 * @param {string} text          Texto del mensaje
 * @param {Array<{title:string, payload:string}>} quickReplies  Máx 13
 */
async function sendQuickReplies(config, recipientId, text, quickReplies) {
  const { access_token } = config

  const body = {
    recipient:      { id: recipientId },
    messaging_type: 'RESPONSE',
    message: {
      text,
      quick_replies: quickReplies.slice(0, 13).map(qr => ({
        content_type: 'text',
        title:        qr.title.slice(0, 20), // Meta limita a 20 chars
        payload:      qr.payload || qr.title,
      })),
    },
  }

  try {
    const res = await axios.post(`${GRAPH_BASE}/me/messages`, body, {
      params:  { access_token },
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
    })
    return res.data
  } catch (err) {
    logger.error({ err: err.response?.data }, '[Meta] Error enviando quick replies')
    throw err
  }
}

/**
 * Obtiene el nombre del usuario en Messenger usando su PSID.
 * Requiere el permiso pages_user_name en la Meta App.
 *
 * @param {string} psid         Page Scoped User ID
 * @param {string} accessToken  Page Access Token
 * @returns {Promise<string>}   Nombre o string vacío si falla
 */
async function getMessengerUserName(psid, accessToken) {
  try {
    const res = await axios.get(`${GRAPH_BASE}/${psid}`, {
      params:  { fields: 'name,first_name,last_name', access_token: accessToken },
      timeout: 5_000,
    })
    return res.data?.name || [res.data?.first_name, res.data?.last_name].filter(Boolean).join(' ') || ''
  } catch {
    return ''
  }
}

/**
 * Obtiene info básica de usuario de Instagram.
 * Retorna string vacío si no tiene permiso o falla.
 *
 * @param {string} igsid        Instagram Scoped ID
 * @param {string} accessToken  Page Access Token
 * @returns {Promise<string>}
 */
async function getInstagramUserName(igsid, accessToken) {
  try {
    const res = await axios.get(`${GRAPH_BASE}/${igsid}`, {
      params:  { fields: 'name,username', access_token: accessToken },
      timeout: 5_000,
    })
    return res.data?.name || res.data?.username || ''
  } catch {
    return ''
  }
}

/**
 * Verifica que un Page Access Token sea válido llamando a /me.
 * Útil para el botón "Probar conexión" del wizard.
 *
 * @param {string} accessToken
 * @returns {Promise<{ valid: boolean, page_name?: string, page_id?: string, error?: string }>}
 */
async function verifyPageToken(accessToken) {
  try {
    const res = await axios.get(`${GRAPH_BASE}/me`, {
      params:  { fields: 'id,name', access_token: accessToken },
      timeout: 8_000,
    })
    return { valid: true, page_name: res.data.name, page_id: res.data.id }
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message
    return { valid: false, error: msg }
  }
}

/**
 * Envía un mensaje de texto a un usuario de Instagram DM.
 *
 * @param {object} config       channel.config del canal instagram_dm
 * @param {string} recipientId  IGSID del usuario de Instagram
 * @param {string|object} content  Texto o objeto con propiedad content
 * @returns {Promise<string|null>}  message_id retornado por la API o null
 */
async function sendInstagramMessage(config, recipientId, content) {
  const { access_token, page_id } = config
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${page_id}/messages`

  const body = {
    recipient: { id: recipientId },
    message: { text: typeof content === 'string' ? content : content.content },
    messaging_type: 'RESPONSE',
  }

  const res = await axios.post(url, body, {
    params: { access_token },
    headers: { 'Content-Type': 'application/json' },
    timeout: 10_000,
  })

  return res.data?.message_id || null
}

/**
 * Parsea el payload de webhook de Instagram y retorna un array de mensajes normalizados.
 * Ignora echoes y eventos sin mensaje (delivery, read, etc.).
 *
 * @param {object} body  Cuerpo del webhook de Instagram
 * @returns {Array<{ pageId, senderId, recipientId, text, messageId, timestamp }>}
 */
function parseInstagramWebhook(body) {
  const messages = []
  for (const entry of (body.entry || [])) {
    for (const messaging of (entry.messaging || [])) {
      // Ignorar echoes (mensajes enviados por la propia página) y eventos sin mensaje
      if (!messaging.message || messaging.message.is_echo) continue
      messages.push({
        pageId:      entry.id,
        senderId:    messaging.sender.id,
        recipientId: messaging.recipient.id,
        text:        messaging.message.text || '',
        messageId:   messaging.message.mid  || '',
        timestamp:   messaging.timestamp,
      })
    }
  }
  return messages
}

module.exports = {
  sendMetaMessage,
  sendQuickReplies,
  getMessengerUserName,
  getInstagramUserName,
  verifyPageToken,
  sendInstagramMessage,
  parseInstagramWebhook,
}
