'use strict'

const axios = require('axios')
const logger = require('../../utils/logger')

const SIIGO_BASE = 'https://api.siigo.com'

// In-memory token cache: username → { token, expiresAt }
const TOKEN_CACHE = new Map()

async function getToken(username, accessKey) {
  const key = `siigo:${username}`
  const cached = TOKEN_CACHE.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.token

  const res = await axios.post(`${SIIGO_BASE}/auth`, { username, access_key: accessKey }, {
    headers: { 'Content-Type': 'application/json', 'Partner-Id': 'NexoraChat' },
  })
  const { access_token, expires_in } = res.data
  TOKEN_CACHE.set(key, { token: access_token, expiresAt: Date.now() + ((expires_in || 3600) - 60) * 1000 })
  return access_token
}

async function apiCall(credentials, method, path, params = null, data = null) {
  const token = await getToken(credentials.username, credentials.access_key)
  try {
    const res = await axios({
      method, url: `${SIIGO_BASE}${path}`, params, data,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Partner-Id': 'NexoraChat' },
    })
    return res.data
  } catch (err) {
    logger.error({ err: err.response?.data }, `[Siigo] ${method} ${path} error`)
    throw err
  }
}

async function getCustomer(credentials, identifier) {
  const res = await apiCall(credentials, 'GET', '/v1/customers', { identification: identifier, page_size: 1 })
  return res?.results?.[0] || null
}

async function getInvoices(credentials, customerId, filters = {}) {
  const res = await apiCall(credentials, 'GET', '/v1/invoices', { customer_id: customerId, ...filters })
  return res?.results || []
}

async function createInvoice(credentials, data) {
  return apiCall(credentials, 'POST', '/v1/invoices', null, data)
}

async function getAccountBalance(credentials, customerId) {
  const invoices = await getInvoices(credentials, customerId, { invoice_type_id: '1' })
  const unpaid = invoices.filter(inv => (inv.balance || 0) > 0)
  const total = unpaid.reduce((sum, inv) => sum + (inv.balance || 0), 0)
  return { customer_id: customerId, total_balance: total, pending_count: unpaid.length, invoices: unpaid.slice(0, 10) }
}

async function registerPayment(credentials, invoiceId, data) {
  return apiCall(credentials, 'POST', '/v1/payments', null, { invoice_id: invoiceId, ...data })
}

async function testConnection(credentials) {
  try {
    await getToken(credentials.username, credentials.access_key)
    await apiCall(credentials, 'GET', '/v1/customers', { page_size: 1 })
    return { valid: true }
  } catch (err) {
    return { valid: false, error: err.response?.data?.Errors?.[0]?.Message || err.message }
  }
}

module.exports = { getCustomer, getInvoices, createInvoice, getAccountBalance, registerPayment, testConnection }
