'use strict'

/**
 * stripe.gateway.js — Stripe Payment Links para el bot de ventas.
 *
 * IMPORTANTE: este archivo es completamente independiente de stripe.service.js
 * que maneja la facturación SaaS de NexoraChat. Este servicio usa las
 * credenciales del CLIENTE (workspace) para cobrar a sus propios clientes.
 *
 * Usa la Stripe Checkout Sessions API (mode: 'payment').
 * Documentación: https://stripe.com/docs/api/checkout/sessions
 */

const axios  = require('axios')
const logger = require('../../utils/logger')

const STRIPE_API = 'https://api.stripe.com/v1'

/**
 * Hace una petición a la API de Stripe con las credenciales del workspace.
 * Stripe usa application/x-www-form-urlencoded en POST.
 */
async function stripeRequest(method, path, data = {}, secretKey) {
  if (!secretKey) {
    throw Object.assign(new Error('Stripe secret_key no configurada para este workspace'), { statusCode: 400 })
  }

  const params = new URLSearchParams()
  function flatten(obj, prefix = '') {
    for (const [key, val] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}[${key}]` : key
      if (val === null || val === undefined) continue
      if (typeof val === 'object' && !Array.isArray(val)) {
        flatten(val, fullKey)
      } else if (Array.isArray(val)) {
        val.forEach((item, i) => {
          if (typeof item === 'object') flatten(item, `${fullKey}[${i}]`)
          else params.append(`${fullKey}[${i}]`, item)
        })
      } else {
        params.append(fullKey, String(val))
      }
    }
  }
  flatten(data)

  try {
    const res = await axios({
      method,
      url: `${STRIPE_API}${path}`,
      data: method !== 'get' ? params.toString() : undefined,
      params: method === 'get' ? data : undefined,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30_000,
    })
    return res.data
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message
    logger.error({ err: msg, path }, '[Stripe] Error en request')
    throw Object.assign(new Error(`Stripe: ${msg}`), { statusCode: err.response?.status || 502 })
  }
}

/**
 * Crea un Checkout Session de pago único (mode: 'payment').
 *
 * @param {object} opts
 * @param {string}   opts.secretKey       - Stripe secret key del workspace
 * @param {string}   opts.workspaceId     - Para metadata (identificar en webhook)
 * @param {string}   opts.paymentLinkId   - ID del PaymentLink en MongoDB (para webhook)
 * @param {Array}    opts.items           - [{ name, quantity, unit_price, currency }]
 * @param {string}   opts.currency        - ISO 4217 (USD, COP, MXN, etc.)
 * @param {string}   opts.description     - Descripción visible en checkout
 * @param {string}   opts.successUrl      - URL de redirección tras pago exitoso
 * @param {string}   opts.cancelUrl       - URL si el cliente cancela
 * @param {number}   [opts.expiresIn]     - Segundos de validez (default: 1800 = 30min)
 * @returns {{ url: string, sessionId: string }}
 */
async function createCheckoutSession({
  secretKey,
  workspaceId,
  paymentLinkId,
  items,
  currency,
  description,
  successUrl,
  cancelUrl,
  expiresIn = 1800,
}) {
  const lineItems = items.map((item, i) => ({
    [`line_items[${i}][price_data][currency]`]:           currency.toLowerCase(),
    [`line_items[${i}][price_data][unit_amount]`]:        Math.round(item.unit_price * 100), // centavos
    [`line_items[${i}][price_data][product_data][name]`]: item.name,
    [`line_items[${i}][quantity]`]:                       item.quantity,
  }))

  // Flatten line_items into a single object
  const lineItemsFlat = Object.assign({}, ...lineItems)

  const session = await stripeRequest('post', '/checkout/sessions', {
    mode:        'payment',
    success_url: successUrl || 'https://NexoraChat.com/payment/success',
    cancel_url:  cancelUrl  || 'https://NexoraChat.com/payment/cancel',
    expires_at:  Math.floor(Date.now() / 1000) + expiresIn,
    'payment_intent_data[description]': description,
    'metadata[workspace_id]':   workspaceId,
    'metadata[payment_link_id]': paymentLinkId,
    ...lineItemsFlat,
  }, secretKey)

  return {
    url:       session.url,
    sessionId: session.id,
  }
}

/**
 * Recupera una Checkout Session de Stripe.
 */
async function getCheckoutSession(sessionId, secretKey) {
  return stripeRequest('get', `/checkout/sessions/${sessionId}`, {}, secretKey)
}

/**
 * Verifica la firma HMAC-SHA256 de un webhook de Stripe.
 * @param {string|Buffer} rawBody   - Body crudo (sin parsear)
 * @param {string}        signature - Header stripe-signature
 * @param {string}        secret    - Webhook secret (whsec_xxx) del workspace
 * @returns {object|null} Evento parseado o null si la firma es inválida
 */
function verifyWebhookSignature(rawBody, signature, secret) {
  if (!signature || !secret) return null

  const crypto = require('crypto')
  const parts  = {}
  signature.split(',').forEach(part => {
    const [k, v] = part.split('=')
    parts[k] = v
  })

  const { t, v1 } = parts
  if (!t || !v1) return null

  const payload  = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')
  const signed   = `${t}.${payload}`
  const expected = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex')

  const tolerance = 300 // 5 minutos
  if (Math.abs(Date.now() / 1000 - parseInt(t)) > tolerance) return null

  if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'))) return null

  return JSON.parse(payload)
}

/**
 * Verifica las credenciales de Stripe haciendo una llamada ligera.
 * @param {string} secretKey
 * @returns {{ valid: boolean, account_id?: string, error?: string }}
 */
async function verifyStripeCredentials(secretKey) {
  try {
    const account = await stripeRequest('get', '/account', {}, secretKey)
    return { valid: true, account_id: account.id, display_name: account.display_name || account.business_profile?.name }
  } catch (err) {
    return { valid: false, error: err.message }
  }
}

module.exports = {
  createCheckoutSession,
  getCheckoutSession,
  verifyWebhookSignature,
  verifyStripeCredentials,
}
