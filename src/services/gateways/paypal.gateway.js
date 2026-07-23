'use strict'

/**
 * paypal.gateway.js — PayPal Orders API v2 para el bot de ventas.
 *
 * Usa las credenciales del CLIENTE (workspace), no de NexoraChat.
 * Documentación: https://developer.paypal.com/docs/api/orders/v2/
 *
 * Flujo:
 *   1. Obtener OAuth2 token (client_credentials)
 *   2. Crear Order (intent: CAPTURE) → obtener URL de aprobación
 *   3. Comprador aprueba → PayPal redirige a return_url
 *   4. Webhook CHECKOUT.ORDER.APPROVED / PAYMENT.CAPTURE.COMPLETED confirma el pago
 */

const axios  = require('axios')
const crypto = require('crypto')
const logger = require('../../utils/logger')

const PP_API_LIVE    = 'https://api-m.paypal.com'
const PP_API_SANDBOX = 'https://api-m.sandbox.paypal.com'

function getBase(testMode) {
  return testMode ? PP_API_SANDBOX : PP_API_LIVE
}

/**
 * Obtiene un access token OAuth2 de PayPal (client_credentials).
 */
async function getAccessToken(clientId, clientSecret, testMode = false) {
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error('PayPal client_id y client_secret son requeridos'), { statusCode: 400 })
  }
  try {
    const res = await axios.post(
      `${getBase(testMode)}/v1/oauth2/token`,
      'grant_type=client_credentials',
      {
        auth: { username: clientId, password: clientSecret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15_000,
      }
    )
    return res.data.access_token
  } catch (err) {
    const msg = err.response?.data?.error_description || err.message
    throw Object.assign(new Error(`PayPal auth: ${msg}`), { statusCode: err.response?.status || 502 })
  }
}

/**
 * Crea un Order de PayPal (modo CAPTURE).
 *
 * @param {object} opts
 * @param {string}   opts.clientId         - PayPal App client ID del workspace
 * @param {string}   opts.clientSecret     - PayPal App client secret del workspace
 * @param {boolean}  [opts.testMode]       - Usar sandbox
 * @param {string}   opts.paymentLinkId    - ID del PaymentLink en MongoDB (custom_id)
 * @param {Array}    opts.items            - [{ name, quantity, unit_price }]
 * @param {string}   opts.currency         - ISO 4217 (USD, MXN, COP…)
 * @param {string}   opts.description      - Descripción del pago
 * @param {string}   [opts.successUrl]     - return_url tras aprobación
 * @param {string}   [opts.cancelUrl]      - cancel_url si abandona
 * @returns {{ url: string, orderId: string }}
 */
async function createOrder({
  clientId,
  clientSecret,
  testMode = false,
  paymentLinkId,
  items,
  currency,
  description,
  successUrl,
  cancelUrl,
}) {
  const token = await getAccessToken(clientId, clientSecret, testMode)

  // Calcular total
  const total = items.reduce((sum, i) => sum + (i.unit_price * i.quantity), 0)
  const totalStr = total.toFixed(2)

  const body = {
    intent: 'CAPTURE',
    purchase_units: [{
      custom_id:   paymentLinkId,
      description: description?.slice(0, 127),
      amount: {
        currency_code: currency.toUpperCase(),
        value:         totalStr,
        breakdown: {
          item_total: { currency_code: currency.toUpperCase(), value: totalStr },
        },
      },
      items: items.map(i => ({
        name:       i.name.slice(0, 127),
        quantity:   String(i.quantity),
        unit_amount: { currency_code: currency.toUpperCase(), value: i.unit_price.toFixed(2) },
      })),
    }],
    application_context: {
      return_url:      successUrl || 'https://NexoraChat.com/payment/success',
      cancel_url:      cancelUrl  || 'https://NexoraChat.com/payment/cancel',
      brand_name:      'NexoraChat',
      shipping_preference: 'NO_SHIPPING',
      user_action:     'PAY_NOW',
    },
  }

  try {
    const res = await axios.post(
      `${getBase(testMode)}/v2/checkout/orders`,
      body,
      {
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      }
    )

    const approveLink = res.data.links?.find(l => l.rel === 'approve')
    if (!approveLink) {
      throw new Error('PayPal no retornó URL de aprobación')
    }

    return {
      url:     approveLink.href,
      orderId: res.data.id,
    }
  } catch (err) {
    if (err.response) {
      const msg = err.response.data?.message || JSON.stringify(err.response.data)
      logger.error({ err: msg }, '[PayPal] Error creando order')
      throw Object.assign(new Error(`PayPal: ${msg}`), { statusCode: err.response.status || 502 })
    }
    throw err
  }
}

/**
 * Obtiene los datos de un Order de PayPal.
 */
async function getOrder(orderId, clientId, clientSecret, testMode = false) {
  const token = await getAccessToken(clientId, clientSecret, testMode)
  try {
    const res = await axios.get(
      `${getBase(testMode)}/v2/checkout/orders/${orderId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
      }
    )
    return res.data
  } catch (err) {
    const msg = err.response?.data?.message || err.message
    throw Object.assign(new Error(`PayPal: ${msg}`), { statusCode: err.response?.status || 502 })
  }
}

/**
 * Verifica la firma de un webhook de PayPal.
 * PayPal usa una verificación via API (no HMAC local).
 *
 * @param {object} opts
 * @param {string}   opts.webhookId         - ID del webhook en el dashboard de PayPal
 * @param {object}   opts.headers           - Headers de la petición (objeto)
 * @param {string}   opts.rawBody           - Body crudo como string
 * @param {string}   opts.clientId
 * @param {string}   opts.clientSecret
 * @param {boolean}  [opts.testMode]
 * @returns {boolean}
 */
async function verifyWebhookSignature({ webhookId, headers, rawBody, clientId, clientSecret, testMode = false }) {
  if (!webhookId) {
    // Sin webhook_id configurado, omitir verificación (no recomendado en producción)
    logger.warn('[PayPal] webhook_id no configurado, verificación omitida')
    return true
  }

  try {
    const token = await getAccessToken(clientId, clientSecret, testMode)
    const res   = await axios.post(
      `${getBase(testMode)}/v1/notifications/verify-webhook-signature`,
      {
        auth_algo:          headers['paypal-auth-algo'],
        cert_url:           headers['paypal-cert-url'],
        transmission_id:    headers['paypal-transmission-id'],
        transmission_sig:   headers['paypal-transmission-sig'],
        transmission_time:  headers['paypal-transmission-time'],
        webhook_id:         webhookId,
        webhook_event:      JSON.parse(rawBody),
      },
      {
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      }
    )
    return res.data.verification_status === 'SUCCESS'
  } catch (err) {
    logger.error({ err: err.message }, '[PayPal] Error verificando webhook')
    return false
  }
}

/**
 * Verifica las credenciales de PayPal obteniendo un access token.
 * @param {string}  clientId
 * @param {string}  clientSecret
 * @param {boolean} testMode
 * @returns {{ valid: boolean, error?: string }}
 */
async function verifyPayPalCredentials(clientId, clientSecret, testMode = false) {
  try {
    await getAccessToken(clientId, clientSecret, testMode)
    return { valid: true, display_name: testMode ? 'Sandbox activado' : 'Producción activada' }
  } catch (err) {
    return { valid: false, error: err.message }
  }
}

module.exports = {
  createOrder,
  getOrder,
  verifyWebhookSignature,
  verifyPayPalCredentials,
}
