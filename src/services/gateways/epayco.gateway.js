'use strict'

/**
 * epayco.gateway.js — ePayco para el bot de ventas (Colombia).
 *
 * Usa las credenciales del CLIENTE (workspace), no de NexoraChat.
 * Documentación: https://docs.epayco.co/
 *
 * Flujo:
 *   1. Crear un link de pago (POST /restpagos/v2/linkdepago/crear)
 *      con las credenciales del workspace
 *   2. Cliente paga en la URL de ePayco
 *   3. ePayco envía confirmación al URL configurado (/webhooks/payments/epayco/:workspaceId)
 *   4. Verificar firma x_signature y actualizar el PaymentLink
 */

const axios  = require('axios')
const crypto = require('crypto')
const logger = require('../../utils/logger')

const EPAYCO_API = 'https://secure.payco.co'

/**
 * Obtiene el token de autenticación de ePayco.
 */
async function getToken(publicKey, privateKey) {
  try {
    const res = await axios.post(
      `${EPAYCO_API}/restpagos/v2/token`,
      null,
      {
        headers: {
          'Content-Type': 'application/json',
        },
        auth: { username: publicKey, password: privateKey },
        timeout: 15_000,
      }
    )
    return res.data.token
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.textResponse || err.message
    throw Object.assign(new Error(`ePayco auth: ${msg}`), { statusCode: err.response?.status || 502 })
  }
}

/**
 * Crea un link de pago en ePayco.
 *
 * @param {object} opts
 * @param {string}   opts.pCustIdCliente    - p_cust_id_cliente del workspace
 * @param {string}   opts.pKey             - p_key del workspace
 * @param {string}   opts.publicKey        - public_key del workspace
 * @param {string}   opts.privateKey       - private_key del workspace
 * @param {string}   opts.paymentLinkId    - ID del PaymentLink en MongoDB
 * @param {Array}    opts.items            - [{ name, quantity, unit_price }]
 * @param {string}   opts.currency         - COP o USD
 * @param {string}   opts.description      - Descripción del pago
 * @param {string}   [opts.confirmUrl]     - URL de confirmación (webhook)
 * @param {string}   [opts.responseUrl]    - URL de respuesta al comprador
 * @param {boolean}  [opts.testMode]       - Activar modo test (p_test = 1)
 * @returns {{ url: string, epaycoId: string }}
 */
async function createPaymentLink({
  pCustIdCliente,
  pKey,
  publicKey,
  privateKey,
  paymentLinkId,
  items,
  currency,
  description,
  confirmUrl,
  responseUrl,
  testMode = false,
}) {
  if (!pCustIdCliente || !pKey) {
    throw Object.assign(new Error('ePayco p_cust_id_cliente y p_key son requeridos'), { statusCode: 400 })
  }

  const token = await getToken(publicKey || pCustIdCliente, privateKey || pKey)
  const total = items.reduce((sum, i) => sum + (i.unit_price * i.quantity), 0)

  const body = {
    name:       description?.slice(0, 50) || 'Pago NexoraChat',
    description: description?.slice(0, 200),
    currency:    (currency || 'COP').toUpperCase(),
    amount:      total.toFixed(2),
    tax_base:    '0',
    tax:         '0',
    country:     'CO',
    lang:        'ES',
    external:    'false',
    p_confirm_method: 'post',
    // external_reference para identificar en webhook
    extra1:      paymentLinkId,
    extra2:      'NexoraChat',
    p_test:      testMode ? '1' : '0',
    p_cust_id_cliente: pCustIdCliente,
    p_key:       pKey,
    url_confirmation: confirmUrl || '',
    url_response:     responseUrl || 'https://NexoraChat.com/payment/success',
  }

  try {
    const res = await axios.post(
      `${EPAYCO_API}/restpagos/v2/linkdepago/crear`,
      body,
      {
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      }
    )

    const data = res.data

    if (!data.success && !data.data?.checkout_url) {
      throw new Error(data.textResponse || data.title || 'Error al crear link de pago')
    }

    const checkoutUrl = data.data?.checkout_url || data.data?.link
    const linkId      = data.data?.linkId || data.data?.id || ''

    return {
      url:      checkoutUrl,
      epaycoId: String(linkId),
    }
  } catch (err) {
    if (err.response) {
      const msg = err.response.data?.textResponse || err.response.data?.message || err.message
      logger.error({ err: msg }, '[ePayco] Error creando link de pago')
      throw Object.assign(new Error(`ePayco: ${msg}`), { statusCode: err.response.status || 502 })
    }
    throw err
  }
}

/**
 * Obtiene los datos de una transacción por su ref_payco.
 */
async function getTransaction(refPayco, pCustIdCliente, pKey) {
  try {
    const res = await axios.get(
      `${EPAYCO_API}/restpagos/v2/transaction/response.json`,
      {
        params: {
          x_ref_payco:       refPayco,
          p_cust_id_cliente: pCustIdCliente,
        },
        timeout: 15_000,
      }
    )
    return res.data
  } catch (err) {
    const msg = err.response?.data?.message || err.message
    throw Object.assign(new Error(`ePayco: ${msg}`), { statusCode: err.response?.status || 502 })
  }
}

/**
 * Verifica la firma de la notificación de ePayco.
 *
 * ePayco firma con MD5:
 *   x_signature = MD5(p_cust_id_cliente + '^' + p_key + '^' + x_ref_payco + '^' + x_transaction_id + '^' + x_amount + '^' + x_currency_code)
 *
 * @param {object} params         - Parámetros del POST de confirmación
 * @param {string} pCustIdCliente
 * @param {string} pKey
 * @returns {boolean}
 */
function verifyWebhookSignature(params, pCustIdCliente, pKey) {
  if (!pKey || !pCustIdCliente) {
    logger.warn('[ePayco] p_cust_id_cliente o p_key no configurados, verificación omitida')
    return true
  }

  const { x_ref_payco, x_transaction_id, x_amount, x_currency_code, x_signature } = params

  if (!x_signature) return false

  const str     = `${pCustIdCliente}^${pKey}^${x_ref_payco}^${x_transaction_id}^${x_amount}^${x_currency_code}`
  const digest  = crypto.createHash('md5').update(str).digest('hex')

  return digest.toLowerCase() === x_signature.toLowerCase()
}

/**
 * Verifica las credenciales de ePayco.
 * @param {string} pCustIdCliente
 * @param {string} pKey
 * @param {string} publicKey
 * @param {string} privateKey
 * @returns {{ valid: boolean, display_name?: string, error?: string }}
 */
async function verifyEpaycoCredentials(pCustIdCliente, pKey, publicKey, privateKey) {
  try {
    await getToken(publicKey || pCustIdCliente, privateKey || pKey)
    return { valid: true, display_name: `Comercio ID: ${pCustIdCliente}` }
  } catch (err) {
    return { valid: false, error: err.message }
  }
}

module.exports = {
  createPaymentLink,
  getTransaction,
  verifyWebhookSignature,
  verifyEpaycoCredentials,
}
