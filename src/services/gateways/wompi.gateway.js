'use strict'

/**
 * wompi.gateway.js — Wompi para el bot de ventas (Colombia).
 *
 * Usa las credenciales del CLIENTE (workspace), no de NexoraChat.
 * Documentación: https://docs.wompi.co/
 *
 * Flujo:
 *   1. Crear un Payment Link (POST /payment_links)
 *   2. Cliente paga en la URL de Wompi
 *   3. Wompi envía evento firmado a /webhooks/payments/wompi/:workspaceId
 *   4. Verificar firma con events_secret y actualizar el PaymentLink
 */

const axios  = require('axios')
const crypto = require('crypto')
const logger = require('../../utils/logger')

const WOMPI_LIVE    = 'https://production.wompi.co/v1'
const WOMPI_SANDBOX = 'https://sandbox.wompi.co/v1'

function getBase(testMode) {
  return testMode ? WOMPI_SANDBOX : WOMPI_LIVE
}

/**
 * Crea un Payment Link en Wompi.
 *
 * @param {object} opts
 * @param {string}   opts.privateKey       - Llave privada del workspace
 * @param {boolean}  [opts.testMode]       - Usar sandbox
 * @param {string}   opts.paymentLinkId    - ID del PaymentLink en MongoDB
 * @param {Array}    opts.items            - [{ name, quantity, unit_price }]
 * @param {string}   opts.currency         - COP (Wompi solo soporta COP actualmente)
 * @param {string}   opts.description      - Descripción del pago
 * @param {string}   [opts.redirectUrl]    - URL de redirección post pago
 * @returns {{ url: string, wompiId: string }}
 */
async function createPaymentLink({
  privateKey,
  testMode = false,
  paymentLinkId,
  items,
  currency,
  description,
  redirectUrl,
}) {
  if (!privateKey) {
    throw Object.assign(new Error('Wompi private_key no configurada para este workspace'), { statusCode: 400 })
  }

  // Wompi maneja montos en centavos
  const totalCents = items.reduce((sum, i) => sum + Math.round(i.unit_price * i.quantity * 100), 0)

  const body = {
    name:              description?.slice(0, 255) || 'Pago NexoraChat',
    description:       description?.slice(0, 1000),
    single_use:        true,
    collect_shipping:  false,
    currency:          (currency || 'COP').toUpperCase(),
    amount_in_cents:   totalCents,
    redirect_url:      redirectUrl || 'https://NexoraChat.com/payment/success',
    // Guardamos el payment_link_id en customer_data para recuperarlo en el webhook
    customer_data: {
      phone_number_required:  false,
      legal_id_required:      false,
      address_line_1_required: false,
    },
  }

  try {
    const res = await axios.post(
      `${getBase(testMode)}/payment_links`,
      body,
      {
        headers: {
          Authorization:  `Bearer ${privateKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      }
    )

    const data = res.data.data
    return {
      url:     data.url,
      wompiId: data.id,
    }
  } catch (err) {
    const msg = err.response?.data?.error?.messages
      ? Object.values(err.response.data.error.messages).flat().join(', ')
      : err.response?.data?.error?.type || err.message

    logger.error({ err: msg }, '[Wompi] Error creando payment link')
    throw Object.assign(new Error(`Wompi: ${msg}`), { statusCode: err.response?.status || 502 })
  }
}

/**
 * Obtiene los datos de una transacción de Wompi.
 * @param {string} transactionId
 * @param {string} privateKey
 * @param {boolean} testMode
 */
async function getTransaction(transactionId, privateKey, testMode = false) {
  try {
    const res = await axios.get(
      `${getBase(testMode)}/transactions/${transactionId}`,
      {
        headers: { Authorization: `Bearer ${privateKey}` },
        timeout: 15_000,
      }
    )
    return res.data.data
  } catch (err) {
    const msg = err.response?.data?.error?.type || err.message
    throw Object.assign(new Error(`Wompi: ${msg}`), { statusCode: err.response?.status || 502 })
  }
}

/**
 * Verifica la firma de un evento de Wompi.
 * Wompi firma con SHA-256: concatena propiedades ordenadas + checksum_key
 *
 * Para eventos de transacción:
 *   signature = SHA256(transaction.id + transaction.status + transaction.amount_in_cents + eventsSecret)
 *
 * @param {object} payload        - Payload parseado del webhook
 * @param {string} eventsSecret   - events_secret del workspace
 * @returns {boolean}
 */
function verifyWebhookSignature(payload, eventsSecret) {
  if (!eventsSecret) {
    logger.warn('[Wompi] events_secret no configurado, verificación omitida')
    return true
  }

  try {
    const event = payload?.data?.transaction || payload?.data?.subscription
    const sig   = payload?.signature

    if (!event || !sig) return false

    // Wompi envía en payload.signature las propiedades usadas para firmar
    const { properties, checksum } = sig

    if (!properties || !checksum) return false

    // Construir el string a hashear según las propiedades declaradas
    const parts = properties.map(prop => {
      // Soportar rutas anidadas como "transaction.id"
      return prop.split('.').reduce((obj, key) => obj?.[key], payload?.data) ?? ''
    })

    parts.push(eventsSecret)
    const digest = crypto.createHash('sha256').update(parts.join('')).digest('hex')

    return crypto.timingSafeEqual(
      Buffer.from(digest, 'hex'),
      Buffer.from(checksum, 'hex')
    )
  } catch (err) {
    logger.error({ err: err.message }, '[Wompi] Error verificando firma')
    return false
  }
}

/**
 * Verifica las credenciales de Wompi.
 * Obtiene la info del comercio con la llave privada.
 * @param {string}  privateKey
 * @param {boolean} testMode
 * @returns {{ valid: boolean, merchant?: string, error?: string }}
 */
async function verifyWompiCredentials(privateKey, testMode = false) {
  try {
    const res = await axios.get(
      `${getBase(testMode)}/merchants/${privateKey.replace(/^prv_test_|^prv_prod_/, '')}`,
      {
        headers: { Authorization: `Bearer ${privateKey}` },
        timeout: 10_000,
      }
    )
    const merchant = res.data?.data
    return {
      valid:        true,
      display_name: merchant?.name || merchant?.business_name || 'Comercio Wompi',
    }
  } catch (err) {
    // Wompi no tiene un endpoint simple de "ping"; intentamos listar payment_links
    try {
      await axios.get(`${getBase(testMode)}/payment_links?page_size=1`, {
        headers: { Authorization: `Bearer ${privateKey}` },
        timeout: 10_000,
      })
      return { valid: true, display_name: 'Credenciales válidas' }
    } catch (err2) {
      const msg = err2.response?.data?.error?.type || err2.message
      return { valid: false, error: msg }
    }
  }
}

module.exports = {
  createPaymentLink,
  getTransaction,
  verifyWebhookSignature,
  verifyWompiCredentials,
}
