'use strict'

/**
 * mercadopago.gateway.js — MercadoPago Checkout Pro para el bot de ventas.
 *
 * Usa las credenciales del CLIENTE (workspace), no de NexoraChat.
 * Documentación: https://www.mercadopago.com.ar/developers/es/reference
 *
 * Flujo:
 *   1. Crear Preference → obtener init_point (URL de pago)
 *   2. Cliente paga → MP envía notificación IPN a /webhooks/payments/mercadopago/:workspaceId
 *   3. Verificar el pago via GET /v1/payments/:id con el access_token del workspace
 */

const axios  = require('axios')
const logger = require('../../utils/logger')

const MP_API = 'https://api.mercadopago.com'

/**
 * Crea una Preference de pago en MercadoPago (Checkout Pro).
 *
 * @param {object} opts
 * @param {string}   opts.accessToken      - Access token del workspace
 * @param {string}   opts.workspaceId      - Para metadata/external_reference
 * @param {string}   opts.paymentLinkId    - ID del PaymentLink en MongoDB
 * @param {Array}    opts.items            - [{ name, quantity, unit_price, currency }]
 * @param {string}   opts.description      - Descripción general
 * @param {string}   [opts.payerEmail]     - Email del comprador (opcional)
 * @param {string}   opts.notificationUrl  - URL del webhook de NexoraChat
 * @param {string}   [opts.successUrl]     - Redirección tras pago aprobado
 * @param {string}   [opts.failureUrl]     - Redirección tras pago rechazado
 * @param {string}   [opts.pendingUrl]     - Redirección tras pago pendiente
 * @returns {{ url: string, preferenceId: string }}
 */
async function createPreference({
  accessToken,
  workspaceId,
  paymentLinkId,
  items,
  description,
  payerEmail,
  notificationUrl,
  successUrl,
  failureUrl,
  pendingUrl,
}) {
  if (!accessToken) {
    throw Object.assign(new Error('MercadoPago access_token no configurado para este workspace'), { statusCode: 400 })
  }

  const body = {
    items: items.map(item => ({
      title:       item.name,
      quantity:    item.quantity,
      unit_price:  item.unit_price,
      currency_id: item.currency || 'USD',
    })),
    external_reference: paymentLinkId,  // lo recibimos en el webhook para identificar el link
    metadata: {
      workspace_id:    workspaceId,
      payment_link_id: paymentLinkId,
    },
    notification_url: notificationUrl,
    back_urls: {
      success: successUrl || 'https://NexoraChat.com/payment/success',
      failure: failureUrl || 'https://NexoraChat.com/payment/cancel',
      pending: pendingUrl || 'https://NexoraChat.com/payment/pending',
    },
    auto_return: 'approved',
  }

  if (payerEmail) {
    body.payer = { email: payerEmail }
  }

  try {
    const res = await axios.post(
      `${MP_API}/checkout/preferences`,
      body,
      {
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      }
    )

    return {
      url:          res.data.init_point,         // URL producción
      sandboxUrl:   res.data.sandbox_init_point, // URL sandbox
      preferenceId: res.data.id,
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message
    logger.error({ err: msg }, '[MercadoPago] Error creando preference')
    throw Object.assign(new Error(`MercadoPago: ${msg}`), { statusCode: err.response?.status || 502 })
  }
}

/**
 * Obtiene los datos de un pago por su ID (para verificar en el webhook).
 */
async function getPayment(paymentId, accessToken) {
  try {
    const res = await axios.get(
      `${MP_API}/v1/payments/${paymentId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 15_000,
      }
    )
    return res.data
  } catch (err) {
    const msg = err.response?.data?.message || err.message
    throw Object.assign(new Error(`MercadoPago: ${msg}`), { statusCode: err.response?.status || 502 })
  }
}

/**
 * Verifica la firma de un webhook de MercadoPago.
 *
 * MP firma los eventos con HMAC-SHA256 cuando se configura una secret key en
 * la aplicación. El header `x-signature` tiene el formato:
 *   ts=<timestamp>,v1=<hmac_hex>
 * El string a firmar es: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
 *
 * Si no hay secret configurado (o el header no viene), acepta el evento pero
 * registra un warning. La verificación real del pago se hace consultando la
 * API de MP con getPayment().
 *
 * @param {object} body        - Payload parseado del webhook
 * @param {object} headers     - Headers de la petición
 * @param {string} [secret]    - Webhook secret configurado en la app de MP
 * @returns {boolean}
 */
function verifyWebhookSignature(body, headers, secret) {
  const xSig = headers['x-signature']
  const xReqId = headers['x-request-id']

  if (!secret) {
    logger.warn('[MercadoPago] webhook secret no configurado, verificación omitida')
    return true
  }

  if (!xSig) {
    logger.warn('[MercadoPago] header x-signature ausente')
    return false
  }

  try {
    const crypto = require('crypto')
    // Parsear "ts=...,v1=..."
    const parts = {}
    xSig.split(',').forEach(part => {
      const [k, v] = part.trim().split('=')
      parts[k] = v
    })

    const { ts, v1 } = parts
    if (!ts || !v1) return false

    const dataId = body?.data?.id || ''
    const manifest = [
      dataId    ? `id:${dataId};`             : '',
      xReqId    ? `request-id:${xReqId};`     : '',
      ts        ? `ts:${ts};`                 : '',
    ].join('')

    const digest = crypto.createHmac('sha256', secret).update(manifest).digest('hex')
    return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(v1, 'hex'))
  } catch (err) {
    logger.error({ err: err.message }, '[MercadoPago] Error verificando firma webhook')
    return false
  }
}

/**
 * Verifica las credenciales de MercadoPago con una llamada ligera.
 * @param {string} accessToken
 * @returns {{ valid: boolean, user_id?: number, email?: string, error?: string }}
 */
async function verifyMPCredentials(accessToken) {
  try {
    const res = await axios.get(`${MP_API}/v1/account/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10_000,
    })
    return {
      valid:   true,
      user_id: res.data.id,
      email:   res.data.email,
      site_id: res.data.site_id,
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.error || err.message
    return { valid: false, error: msg }
  }
}

module.exports = {
  createPreference,
  getPayment,
  verifyWebhookSignature,
  verifyMPCredentials,
}
