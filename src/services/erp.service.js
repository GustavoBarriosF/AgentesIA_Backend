'use strict'

/**
 * erp.service.js
 *
 * Capa de orquestación para integraciones ERP por workspace.
 * Delega operaciones a los adaptadores específicos (Alegra, Siigo, QuickBooks).
 *
 * Características:
 *   - Caché Redis (TTL 5 min) para consultas frecuentes (customer, balance, invoices)
 *   - Encriptación AES-256-GCM de credenciales en reposo
 *   - Registro automático de cada operación en sync_log del documento
 *   - Toda operación es por workspace (multi-tenant)
 */

const crypto       = require('crypto')
const ERPIntegration = require('../db/models/erp-integration')
const { getRedis } = require('../db/redis')
const logger       = require('../utils/logger')

const alegraAdapter     = require('./erp/alegra.adapter')
const siigoAdapter      = require('./erp/siigo.adapter')
const quickbooksAdapter = require('./erp/quickbooks.adapter')

const ADAPTERS = {
  alegra:     alegraAdapter,
  siigo:      siigoAdapter,
  quickbooks: quickbooksAdapter,
}

const CACHE_TTL = 300 // 5 minutos en segundos

// ─── Encriptación de credenciales ─────────────────────────────────────────────

const ALGO = 'aes-256-gcm'

function getEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY
  if (!key || key.length < 32) {
    // En desarrollo: clave fija de 32 chars. En producción DEBE estar en .env
    return Buffer.from('NexoraChat-erp-key-dev-000000000', 'utf8').slice(0, 32)
  }
  return Buffer.from(key, 'hex').slice(0, 32)
}

function encryptCredentials(plainObj) {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const json = JSON.stringify(plainObj)
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    iv:      iv.toString('hex'),
    authTag: authTag.toString('hex'),
    data:    encrypted.toString('hex'),
  }
}

function decryptCredentials(encObj) {
  if (!encObj?.iv) return encObj // ya en plano (retrocompatibilidad)
  const key = getEncryptionKey()
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(encObj.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(encObj.authTag, 'hex'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encObj.data, 'hex')),
    decipher.final(),
  ])
  return JSON.parse(decrypted.toString('utf8'))
}

// ─── Caché Redis ───────────────────────────────────────────────────────────────

function cacheKey(workspaceId, operation, identifier) {
  return `erp:${workspaceId}:${operation}:${identifier}`
}

async function fromCache(key) {
  try {
    const redis = getRedis()
    const raw = await redis.get(key)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

async function toCache(key, value) {
  try {
    const redis = getRedis()
    await redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL)
  } catch { /* caché no crítico */ }
}

async function invalidateCacheKeys(workspaceId, identifier) {
  try {
    const redis = getRedis()
    const keys = [
      cacheKey(workspaceId, 'customer', identifier),
      cacheKey(workspaceId, 'balance', identifier),
      cacheKey(workspaceId, 'invoices', identifier),
    ]
    if (keys.length) await redis.del(...keys)
  } catch { /* ignorar */ }
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

/**
 * Obtiene la integración ERP activa del workspace.
 * Lanza un error descriptivo si no existe ninguna configurada.
 */
async function getActiveIntegration(workspaceId) {
  const integration = await ERPIntegration.findOne({
    workspace_id: workspaceId,
    active: true,
  }).lean()

  if (!integration) {
    const err = new Error('No hay integración ERP activa para este workspace')
    err.code = 'erp_not_configured'
    err.statusCode = 422
    throw err
  }

  return integration
}

function getAdapter(provider) {
  const adapter = ADAPTERS[provider]
  if (!adapter) throw new Error(`Adaptador ERP no encontrado: ${provider}`)
  return adapter
}

/**
 * Agrega una entrada al sync_log del documento (máx. 100 entradas).
 */
async function appendLog(integrationId, action, status, detail = null) {
  await ERPIntegration.findByIdAndUpdate(integrationId, {
    $push: {
      sync_log: {
        $each:     [{ timestamp: new Date(), action, status, detail }],
        $slice:    -100,
        $position: 0,
      },
    },
    $set: {
      last_sync:  status === 'success' ? new Date() : undefined,
      last_error: status === 'error'   ? detail      : undefined,
    },
  })
}

// ─── API pública ───────────────────────────────────────────────────────────────

/**
 * Crea una nueva integración ERP para el workspace.
 * Encripta las credenciales antes de guardar.
 */
async function createIntegration(workspaceId, { provider, credentials, config = {} }) {
  const existing = await ERPIntegration.findOne({ workspace_id: workspaceId, provider }).lean()
  if (existing) {
    const err = new Error(`Ya existe una integración ${provider} para este workspace`)
    err.statusCode = 409
    throw err
  }

  const encrypted = encryptCredentials(credentials)
  const integration = await ERPIntegration.create({
    workspace_id: workspaceId,
    provider,
    credentials: encrypted,
    config,
    active: true,
  })

  return toSafeResponse(integration.toObject())
}

/**
 * Actualiza credenciales y/o config de una integración existente.
 */
async function updateIntegration(workspaceId, integrationId, { credentials, config, active }) {
  const integration = await ERPIntegration.findOne({
    _id: integrationId,
    workspace_id: workspaceId,
  })
  if (!integration) {
    const err = new Error('Integración no encontrada')
    err.statusCode = 404
    throw err
  }

  if (credentials) integration.credentials = encryptCredentials(credentials)
  if (config)      Object.assign(integration.config, config)
  if (active !== undefined) integration.active = active

  await integration.save()
  return toSafeResponse(integration.toObject())
}

/**
 * Elimina una integración ERP del workspace.
 */
async function deleteIntegration(workspaceId, integrationId) {
  const result = await ERPIntegration.deleteOne({
    _id: integrationId,
    workspace_id: workspaceId,
  })
  if (!result.deletedCount) {
    const err = new Error('Integración no encontrada')
    err.statusCode = 404
    throw err
  }
}

/**
 * Lista todas las integraciones del workspace (sin credenciales en claro).
 */
async function listIntegrations(workspaceId) {
  const integrations = await ERPIntegration.find({ workspace_id: workspaceId }).lean()
  return integrations.map(toSafeResponse)
}

/**
 * Prueba la conectividad de una integración.
 * No requiere que esté activa (permite testear antes de activar).
 */
async function testConnection(workspaceId, integrationId) {
  const integration = await ERPIntegration.findOne({
    _id: integrationId,
    workspace_id: workspaceId,
  }).lean()
  if (!integration) {
    const err = new Error('Integración no encontrada')
    err.statusCode = 404
    throw err
  }

  const adapter = getAdapter(integration.provider)
  const credentials = decryptCredentials(integration.credentials)
  const result = await adapter.testConnection(credentials)

  const status = result.valid ? 'success' : 'error'
  await appendLog(integration._id, 'test_connection', status, result.error || null)

  return result
}

/**
 * Busca un cliente en el ERP por cédula / NIT / email.
 * Resultado cacheado 5 min.
 */
async function getCustomer(workspaceId, identifier) {
  const integration = await getActiveIntegration(workspaceId)
  const key = cacheKey(workspaceId, 'customer', identifier)
  const cached = await fromCache(key)
  if (cached) return cached

  const adapter = getAdapter(integration.provider)
  const credentials = decryptCredentials(integration.credentials)

  let customer = null
  try {
    customer = await adapter.getCustomer(credentials, identifier)
    await appendLog(integration._id, 'get_customer', 'success')
    await toCache(key, customer)
  } catch (err) {
    await appendLog(integration._id, 'get_customer', 'error', err.message)
    throw err
  }

  return customer
}

/**
 * Obtiene el estado de cuenta (cartera) de un cliente.
 * Resultado cacheado 5 min.
 */
async function getAccountBalance(workspaceId, customerId, identifier) {
  const integration = await getActiveIntegration(workspaceId)
  const key = cacheKey(workspaceId, 'balance', identifier || customerId)
  const cached = await fromCache(key)
  if (cached) return cached

  const adapter = getAdapter(integration.provider)
  const credentials = decryptCredentials(integration.credentials)

  let balance = null
  try {
    balance = await adapter.getAccountBalance(credentials, customerId)
    await appendLog(integration._id, 'get_balance', 'success')
    await toCache(key, balance)
  } catch (err) {
    await appendLog(integration._id, 'get_balance', 'error', err.message)
    throw err
  }

  return balance
}

/**
 * Lista facturas de un cliente con filtros opcionales.
 * Resultado cacheado 5 min.
 */
async function getInvoices(workspaceId, customerId, filters = {}) {
  const integration = await getActiveIntegration(workspaceId)
  const key = cacheKey(workspaceId, 'invoices', customerId)
  const cached = await fromCache(key)
  if (cached) return cached

  const adapter = getAdapter(integration.provider)
  const credentials = decryptCredentials(integration.credentials)

  let invoices = []
  try {
    invoices = await adapter.getInvoices(credentials, customerId, filters)
    await appendLog(integration._id, 'get_invoices', 'success')
    await toCache(key, invoices)
  } catch (err) {
    await appendLog(integration._id, 'get_invoices', 'error', err.message)
    throw err
  }

  return invoices
}

/**
 * Crea una factura en el ERP (post-venta automático).
 * Invalida caché del cliente.
 */
async function createInvoice(workspaceId, data) {
  const integration = await getActiveIntegration(workspaceId)
  const adapter = getAdapter(integration.provider)
  const credentials = decryptCredentials(integration.credentials)

  let invoice = null
  try {
    invoice = await adapter.createInvoice(credentials, data)
    await appendLog(integration._id, 'create_invoice', 'success', `invoice_id: ${invoice?.id || invoice?._id || 'N/A'}`)
    // Invalidar caché de facturas del cliente
    if (data.customer_id || data.client?.id) {
      await invalidateCacheKeys(workspaceId, data.customer_id || data.client?.id)
    }
  } catch (err) {
    await appendLog(integration._id, 'create_invoice', 'error', err.message)
    throw err
  }

  return invoice
}

/**
 * Registra un pago en el ERP.
 * Invalida caché del cliente.
 */
async function registerPayment(workspaceId, invoiceId, data) {
  const integration = await getActiveIntegration(workspaceId)
  const adapter = getAdapter(integration.provider)
  const credentials = decryptCredentials(integration.credentials)

  let payment = null
  try {
    payment = await adapter.registerPayment(credentials, invoiceId, data)
    await appendLog(integration._id, 'register_payment', 'success', `invoice: ${invoiceId}`)
    if (data.identifier || data.customer_id) {
      await invalidateCacheKeys(workspaceId, data.identifier || data.customer_id)
    }
  } catch (err) {
    await appendLog(integration._id, 'register_payment', 'error', err.message)
    throw err
  }

  return payment
}

/**
 * Obtiene el sync_log de una integración (para mostrar en el dashboard).
 */
async function getSyncLog(workspaceId, integrationId) {
  const integration = await ERPIntegration.findOne({
    _id: integrationId,
    workspace_id: workspaceId,
  }).select('sync_log last_sync last_error').lean()

  if (!integration) {
    const err = new Error('Integración no encontrada')
    err.statusCode = 404
    throw err
  }

  return integration
}

// ─── Helpers de presentación ──────────────────────────────────────────────────

/**
 * Retorna el documento sin exponer credenciales en claro.
 * Incluye qué campos de credenciales están configurados (booleano).
 */
function toSafeResponse(integration) {
  const { credentials, ...rest } = integration
  const credentials_configured = {}
  if (credentials) {
    // Si es el formato encriptado ({ iv, authTag, data }), reportar según los campos del provider
    if (credentials.iv) {
      credentials_configured._encrypted = true
    } else {
      Object.keys(credentials).forEach(k => {
        credentials_configured[k] = Boolean(credentials[k])
      })
    }
  }
  return { ...rest, credentials_configured }
}

module.exports = {
  createIntegration,
  updateIntegration,
  deleteIntegration,
  listIntegrations,
  testConnection,
  getCustomer,
  getAccountBalance,
  getInvoices,
  createInvoice,
  registerPayment,
  getSyncLog,
  invalidateCacheKeys,
  // Exportar helpers para uso en bot.service.js
  getActiveIntegration,
  decryptCredentials,
  getAdapter,
}
