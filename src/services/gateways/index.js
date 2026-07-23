'use strict'

/**
 * gateways/index.js — Fábrica de pasarelas de pago.
 *
 * Uso:
 *   const { createPaymentLink } = require('./gateways')
 *   const { url, providerId } = await createPaymentLink({ gateway, workspaceId, paymentLinkId, items, currency, description })
 */

const stripe      = require('./stripe.gateway')
const mercadopago = require('./mercadopago.gateway')
const paypal      = require('./paypal.gateway')
const wompi       = require('./wompi.gateway')
const epayco      = require('./epayco.gateway')
const payu        = require('./payu.gateway')
const logger      = require('../../utils/logger')
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3001'

/**
 * Crea un link de pago usando la pasarela configurada del workspace.
 *
 * @param {object} opts
 * @param {object}   opts.gateway         - Documento PaymentGateway del workspace
 * @param {string}   opts.workspaceId     - ID del workspace
 * @param {string}   opts.paymentLinkId   - ID del PaymentLink en MongoDB (para webhook)
 * @param {Array}    opts.items           - [{ name, quantity, unit_price }]
 * @param {string}   opts.currency        - ISO 4217
 * @param {string}   opts.description     - Descripción visible
 * @param {string}   [opts.payerEmail]    - Email del comprador (MercadoPago)
 * @returns {{ url: string, providerId: string }}
 */
async function createPaymentLink({
  gateway,
  workspaceId,
  paymentLinkId,
  items,
  currency,
  description,
  payerEmail,
}) {
  const provider = gateway.provider
  const creds    = gateway.credentials || {}
  const testMode = gateway.test_mode   || false

  switch (provider) {
    // ─── Stripe ────────────────────────────────────────────────────────────────
    case 'stripe': {
      const result = await stripe.createCheckoutSession({
        secretKey:     creds.secret_key,
        workspaceId,
        paymentLinkId,
        items,
        currency,
        description,
        successUrl:    creds.success_url,
        cancelUrl:     creds.cancel_url,
      })
      return { url: result.url, providerId: result.sessionId }
    }

    // ─── MercadoPago ───────────────────────────────────────────────────────────
    case 'mercadopago': {
      const notificationUrl = `${BACKEND_URL}/webhooks/payments/mercadopago/${workspaceId}`
      const result = await mercadopago.createPreference({
        accessToken:     creds.access_token,
        workspaceId,
        paymentLinkId,
        items:           items.map(i => ({ ...i, currency })),
        description,
        payerEmail,
        notificationUrl,
        successUrl:      creds.success_url,
        failureUrl:      creds.cancel_url,
      })
      const url = testMode ? result.sandboxUrl : result.url
      return { url, providerId: result.preferenceId }
    }

    // ─── PayPal ────────────────────────────────────────────────────────────────
    case 'paypal': {
      const result = await paypal.createOrder({
        clientId:     creds.client_id,
        clientSecret: creds.client_secret,
        testMode,
        paymentLinkId,
        items,
        currency,
        description,
        successUrl:   creds.success_url,
        cancelUrl:    creds.cancel_url,
      })
      return { url: result.url, providerId: result.orderId }
    }

    // ─── Wompi ─────────────────────────────────────────────────────────────────
    case 'wompi': {
      const result = await wompi.createPaymentLink({
        privateKey:  creds.private_key,
        testMode,
        paymentLinkId,
        items,
        currency,
        description,
        redirectUrl: creds.success_url,
      })
      return { url: result.url, providerId: result.wompiId }
    }

    // ─── ePayco ────────────────────────────────────────────────────────────────
    case 'epayco': {
      const confirmUrl = `${BACKEND_URL}/webhooks/payments/epayco/${workspaceId}`
      const result = await epayco.createPaymentLink({
        pCustIdCliente: creds.p_cust_id_cliente,
        pKey:           creds.p_key,
        publicKey:      creds.public_key,
        privateKey:     creds.private_key,
        paymentLinkId,
        items,
        currency,
        description,
        confirmUrl,
        responseUrl:    creds.success_url,
        testMode,
      })
      return { url: result.url, providerId: result.epaycoId }
    }

    // ─── PayU ──────────────────────────────────────────────────────────────────
    case 'payu': {
      const confirmationUrl = `${BACKEND_URL}/webhooks/payments/payu/${workspaceId}`
      const result = payu.createCheckoutUrl({
        merchantId:      creds.merchant_id,
        accountId:       creds.account_id,
        apiKey:          creds.api_key,
        paymentLinkId,
        items,
        currency,
        description,
        testMode,
        responseUrl:     creds.response_url,
        confirmationUrl,
        buyerEmail:      payerEmail,
      })
      return { url: result.url, providerId: result.referenceCode }
    }

    default:
      throw Object.assign(
        new Error(`Pasarela '${provider}' no implementada`),
        { statusCode: 501 }
      )
  }
}

/**
 * Verifica las credenciales de una pasarela.
 */
async function verifyGatewayCredentials(provider, credentials, testMode = false) {
  const c = credentials || {}
  switch (provider) {
    case 'stripe':
      return stripe.verifyStripeCredentials(c.secret_key)
    case 'mercadopago':
      return mercadopago.verifyMPCredentials(c.access_token)
    case 'paypal':
      return paypal.verifyPayPalCredentials(c.client_id, c.client_secret, testMode)
    case 'wompi':
      return wompi.verifyWompiCredentials(c.private_key, testMode)
    case 'epayco':
      return epayco.verifyEpaycoCredentials(c.p_cust_id_cliente, c.p_key, c.public_key, c.private_key)
    case 'payu':
      return payu.verifyPayUCredentials(c.api_login, c.api_key, c.merchant_id, testMode)
    default:
      return { valid: false, error: `Proveedor '${provider}' no soportado` }
  }
}

module.exports = { createPaymentLink, verifyGatewayCredentials }
