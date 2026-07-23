'use strict'

/**
 * payu.gateway.js — PayU WebCheckout para el bot de ventas (LATAM).
 *
 * Usa las credenciales del CLIENTE (workspace), no de NexoraChat.
 * Documentación: https://developers.payulatam.com/latam/es/docs/integrations/webcheckout-integration.html
 *
 * Flujo:
 *   1. Calcular firma MD5: MD5("apiKey~merchantId~referenceCode~amount~currency")
 *   2. Generar URL de WebCheckout con los parámetros como query string
 *   3. Cliente paga en la página hospedada de PayU
 *   4. PayU envía confirmación por POST a /webhooks/payments/payu/:workspaceId
 *   5. Verificar firma del webhook y actualizar el PaymentLink
 *
 * Credenciales requeridas:
 *   - merchantId   → ID del comercio en PayU
 *   - accountId    → ID de la cuenta (varía por país: CO, MX, PE, AR, BR…)
 *   - apiKey       → Llave API (para firmar)
 *   - apiLogin     → Login API (para la API REST de consultas)
 */

const axios  = require('axios')
const crypto = require('crypto')
const logger = require('../../utils/logger')

const PAYU_CHECKOUT_PROD    = 'https://checkout.payulatam.com/ppp-web-gateway-payu/'
const PAYU_CHECKOUT_SANDBOX = 'https://sandbox.checkout.payulatam.com/ppp-web-gateway-payu/'
const PAYU_API_PROD         = 'https://api.payulatam.com/payments-api/4.0/service.cgi'
const PAYU_API_SANDBOX      = 'https://sandbox.api.payulatam.com/payments-api/4.0/service.cgi'

function getCheckoutBase(testMode) {
  return testMode ? PAYU_CHECKOUT_SANDBOX : PAYU_CHECKOUT_PROD
}

function getApiBase(testMode) {
  return testMode ? PAYU_API_SANDBOX : PAYU_API_PROD
}

/**
 * Calcula la firma MD5 para el WebCheckout de PayU.
 * Formato: MD5("apiKey~merchantId~referenceCode~amount~currency")
 *
 * @param {string} apiKey
 * @param {string} merchantId
 * @param {string} referenceCode  - Debe ser único por transacción
 * @param {number} amount         - Monto total redondeado a 2 decimales
 * @param {string} currency       - ISO 4217 (COP, USD, MXN, PEN…)
 * @returns {string} MD5 hash en minúsculas
 */
function buildSignature(apiKey, merchantId, referenceCode, amount, currency) {
  const str = `${apiKey}~${merchantId}~${referenceCode}~${amount.toFixed(2)}~${currency}`
  return crypto.createHash('md5').update(str).digest('hex')
}

/**
 * Genera la URL de WebCheckout de PayU con todos los parámetros como query string.
 * PayU acepta tanto POST como GET con los mismos parámetros.
 *
 * @param {object} opts
 * @param {string}   opts.merchantId         - ID del comercio
 * @param {string}   opts.accountId          - ID de la cuenta (por país)
 * @param {string}   opts.apiKey             - Llave API del workspace
 * @param {string}   opts.paymentLinkId      - ID del PaymentLink en MongoDB (referenceCode)
 * @param {Array}    opts.items              - [{ name, quantity, unit_price }]
 * @param {string}   opts.currency           - ISO 4217
 * @param {string}   opts.description        - Descripción del pago (max 255 chars)
 * @param {boolean}  [opts.testMode]         - Usar sandbox (test=1)
 * @param {string}   [opts.responseUrl]      - URL de respuesta al comprador
 * @param {string}   [opts.confirmationUrl]  - URL del webhook de confirmación
 * @param {string}   [opts.buyerEmail]       - Email del comprador (opcional)
 * @param {string}   [opts.buyerFullName]    - Nombre del comprador (opcional)
 * @returns {{ url: string, referenceCode: string }}
 */
function createCheckoutUrl({
  merchantId,
  accountId,
  apiKey,
  paymentLinkId,
  items,
  currency,
  description,
  testMode = false,
  responseUrl,
  confirmationUrl,
  buyerEmail,
  buyerFullName,
}) {
  if (!merchantId || !accountId || !apiKey) {
    throw Object.assign(
      new Error('PayU: merchantId, accountId y apiKey son requeridos'),
      { statusCode: 400 }
    )
  }

  const amount = items.reduce((sum, i) => sum + (i.unit_price * i.quantity), 0)
  const referenceCode = paymentLinkId
  const signature = buildSignature(apiKey, merchantId, referenceCode, amount, currency)

  const params = new URLSearchParams({
    merchantId,
    accountId,
    description:   (description || 'Pago NexoraChat').slice(0, 255),
    referenceCode,
    amount:        amount.toFixed(2),
    currency:      currency.toUpperCase(),
    signature,
    test:          testMode ? '1' : '0',
    responseUrl:   responseUrl  || 'https://NexoraChat.com/payment/success',
    confirmationUrl: confirmationUrl || '',
  })

  if (buyerEmail)    params.append('buyerEmail',    buyerEmail)
  if (buyerFullName) params.append('buyerFullName', buyerFullName)

  const url = `${getCheckoutBase(testMode)}?${params.toString()}`

  return { url, referenceCode }
}

/**
 * Verifica la firma de la notificación de confirmación de PayU.
 *
 * PayU firma con MD5:
 *   new_value = amount_numeric (si termina en .00, usar entero; si no, 1 decimal)
 *   signature = MD5("apiKey~merchant_id~reference_sale~new_value~currency~state_pol")
 *
 * @param {object} params   - Campos del POST de confirmación
 * @param {string} apiKey   - API Key del workspace
 * @returns {boolean}
 */
function verifyWebhookSignature(params, apiKey) {
  if (!apiKey) {
    logger.warn('[PayU] apiKey no configurado, verificación omitida')
    return true
  }

  const { merchant_id, reference_sale, value, currency, state_pol, sign } = params

  if (!sign) return false

  // PayU normaliza el monto: si los decimales son "00", usa el entero; si no, 1 decimal
  const numericValue = parseFloat(value)
  let newValue
  if (numericValue === Math.floor(numericValue)) {
    newValue = numericValue.toFixed(2)  // PayU sigue usando .00 en la firma
  } else {
    // Redondear a 1 decimal
    newValue = (Math.round(numericValue * 10) / 10).toFixed(1)
  }

  const str    = `${apiKey}~${merchant_id}~${reference_sale}~${newValue}~${currency}~${state_pol}`
  const digest = crypto.createHash('md5').update(str).digest('hex')

  return digest.toLowerCase() === sign.toLowerCase()
}

/**
 * Verifica las credenciales de PayU enviando un comando PING a la API REST.
 * @param {string}  apiLogin
 * @param {string}  apiKey
 * @param {string}  merchantId
 * @param {boolean} testMode
 * @returns {{ valid: boolean, display_name?: string, error?: string }}
 */
async function verifyPayUCredentials(apiLogin, apiKey, merchantId, testMode = false) {
  if (!apiLogin || !apiKey || !merchantId) {
    return { valid: false, error: 'apiLogin, apiKey y merchantId son requeridos' }
  }

  try {
    const res = await axios.post(
      getApiBase(testMode),
      {
        test:     testMode,
        language: 'es',
        command:  'PING',
        merchant: { apiLogin, apiKey },
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15_000,
      }
    )

    const data = res.data
    if (data.code === 'SUCCESS') {
      return { valid: true, display_name: `Comercio ID: ${merchantId}` }
    }
    return { valid: false, error: data.error || data.description || 'Credenciales inválidas' }
  } catch (err) {
    const msg = err.response?.data?.description || err.response?.data?.error || err.message
    return { valid: false, error: msg }
  }
}

module.exports = {
  createCheckoutUrl,
  buildSignature,
  verifyWebhookSignature,
  verifyPayUCredentials,
}
