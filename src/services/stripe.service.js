'use strict'

/**
 * Stripe service — implementado sobre la REST API v1 de Stripe usando axios.
 * No requiere el paquete oficial 'stripe'; utiliza axios (ya incluido).
 *
 * Para migrar al SDK oficial basta con reemplazar stripeRequest por
 * stripe.checkout.sessions.create(...), etc.
 */

const axios = require('axios')

const STRIPE_API = 'https://api.stripe.com/v1'

/**
 * Realiza una petición autenticada a la API de Stripe.
 * Stripe usa application/x-www-form-urlencoded para POST.
 */
async function stripeRequest(method, path, data = {}) {
  const secretKey = process.env.STRIPE_SECRET_KEY
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY no configurada')

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
        params.append(fullKey, val)
      }
    }
  }
  flatten(data)

  const res = await axios({
    method,
    url: `${STRIPE_API}${path}`,
    data: method !== 'get' ? params.toString() : undefined,
    params: method === 'get' ? data : undefined,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  })

  return res.data
}

// ─── Customer ──────────────────────────────────────────────────────────────────

/**
 * Crea un Customer de Stripe para el workspace.
 */
async function createCustomer({ email, name, workspaceId }) {
  return stripeRequest('post', '/customers', {
    email,
    name,
    metadata: { workspace_id: workspaceId },
  })
}

// ─── Checkout ─────────────────────────────────────────────────────────────────

/**
 * Crea una Checkout Session para suscripción.
 * @param {object} opts
 * @param {string} opts.customerId     - Stripe Customer ID
 * @param {string} opts.priceId        - Stripe Price ID (mensual o anual)
 * @param {string} opts.workspaceId    - Para metadata y URLs
 * @param {string} opts.successUrl     - URL después de pago exitoso
 * @param {string} opts.cancelUrl      - URL si el usuario cancela
 * @param {string} [opts.couponId]     - Stripe Coupon ID a aplicar
 */
async function createCheckoutSession({ customerId, priceId, workspaceId, successUrl, cancelUrl, couponId }) {
  const data = {
    mode: 'subscription',
    customer: customerId,
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    success_url: successUrl,
    cancel_url: cancelUrl,
    'metadata[workspace_id]': workspaceId,
    'subscription_data[metadata][workspace_id]': workspaceId,
  }

  if (couponId) {
    data['discounts[0][coupon]'] = couponId
  }

  return stripeRequest('post', '/checkout/sessions', data)
}

// ─── Billing Portal ───────────────────────────────────────────────────────────

/**
 * Crea una sesión del Customer Portal para gestión de suscripción.
 */
async function createBillingPortalSession({ customerId, returnUrl }) {
  return stripeRequest('post', '/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
  })
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

/**
 * Verifica la firma HMAC del webhook de Stripe.
 * Stripe firma con HMAC-SHA256 sobre `timestamp.payload`.
 */
function verifyWebhookSignature(payload, signature, secret) {
  if (!signature || !secret) return null

  const crypto = require('crypto')
  const parts = Object.fromEntries(
    signature.split(',').map(part => {
      const [k, v] = part.split('=')
      return [k, v]
    })
  )

  const { t, v1 } = parts
  if (!t || !v1) return null

  const signedPayload = `${t}.${payload}`
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload, 'utf8')
    .digest('hex')

  const tolerance = 300 // 5 minutos
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - parseInt(t)) > tolerance) return null

  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) return null

  return JSON.parse(payload)
}

// ─── Invoices ─────────────────────────────────────────────────────────────────

/**
 * Lista las facturas de un Customer en Stripe.
 */
async function listCustomerInvoices(stripeCustomerId, { limit = 10 } = {}) {
  return stripeRequest('get', '/invoices', {
    customer: stripeCustomerId,
    limit,
    expand: ['data.subscription'],
  })
}

module.exports = {
  createCustomer,
  createCheckoutSession,
  createBillingPortalSession,
  verifyWebhookSignature,
  listCustomerInvoices,
}
