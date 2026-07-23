'use strict'

const axios = require('axios')
const logger = require('../../utils/logger')

const QB_BASE_PROD    = 'https://quickbooks.api.intuit.com/v3/company'
const QB_BASE_SANDBOX = 'https://sandbox-quickbooks.api.intuit.com/v3/company'
const INTUIT_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'

// In-memory token cache
const TOKEN_CACHE = new Map()

async function refreshAccessToken(credentials) {
  const key = `qb:${credentials.realm_id}`
  const cached = TOKEN_CACHE.get(key)
  if (cached && Date.now() < cached.expiresAt) return cached.token

  const basicAuth = Buffer.from(`${credentials.client_id}:${credentials.client_secret}`).toString('base64')
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token })

  const res = await axios.post(INTUIT_TOKEN_URL, body.toString(), {
    headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  const { access_token, expires_in, refresh_token } = res.data
  TOKEN_CACHE.set(key, { token: access_token, expiresAt: Date.now() + ((expires_in || 3600) - 60) * 1000 })
  if (refresh_token) credentials.refresh_token = refresh_token // rotate
  return access_token
}

function baseUrl(credentials) {
  const base = credentials.sandbox ? QB_BASE_SANDBOX : QB_BASE_PROD
  return `${base}/${credentials.realm_id}`
}

async function qbGet(credentials, path, params = {}) {
  const token = await refreshAccessToken(credentials)
  try {
    const res = await axios.get(`${baseUrl(credentials)}${path}`, {
      params: { minorversion: 65, ...params },
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    return res.data
  } catch (err) {
    logger.error({ err: err.response?.data }, `[QuickBooks] GET ${path} error`)
    throw err
  }
}

async function qbPost(credentials, path, data) {
  const token = await refreshAccessToken(credentials)
  try {
    const res = await axios.post(`${baseUrl(credentials)}${path}`, data, {
      params: { minorversion: 65 },
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    })
    return res.data
  } catch (err) {
    logger.error({ err: err.response?.data }, `[QuickBooks] POST ${path} error`)
    throw err
  }
}

async function runQuery(credentials, sql) {
  const res = await qbGet(credentials, '/query', { query: sql })
  return res?.QueryResponse || {}
}

async function getCustomer(credentials, identifier) {
  // Try by email first
  const emailResult = await runQuery(credentials,
    `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${identifier.replace(/'/g, "\\'")}' MAXRESULTS 1`)
  if (emailResult?.Customer?.[0]) return emailResult.Customer[0]
  // Fallback: by display name / identification
  const nameResult = await runQuery(credentials,
    `SELECT * FROM Customer WHERE DisplayName LIKE '%${identifier.replace(/'/g, "\\'")}%' MAXRESULTS 1`)
  return nameResult?.Customer?.[0] || null
}

async function getInvoices(credentials, customerId, filters = {}) {
  const res = await runQuery(credentials,
    `SELECT * FROM Invoice WHERE CustomerRef = '${customerId}' ORDERBY MetaData.CreateTime DESC MAXRESULTS 20`)
  return res?.Invoice || []
}

async function createInvoice(credentials, data) {
  const res = await qbPost(credentials, '/invoice', data)
  return res?.Invoice
}

async function getAccountBalance(credentials, customerId) {
  const res = await runQuery(credentials,
    `SELECT * FROM Invoice WHERE CustomerRef = '${customerId}' AND Balance > '0' MAXRESULTS 20`)
  const invoices = res?.Invoice || []
  const total = invoices.reduce((sum, inv) => sum + (inv.Balance || 0), 0)
  return { customer_id: customerId, total_balance: total, pending_count: invoices.length, invoices: invoices.slice(0, 10) }
}

async function registerPayment(credentials, invoiceId, data) {
  const payload = {
    TotalAmt: data.amount,
    CustomerRef: { value: data.customer_id },
    Line: [{ Amount: data.amount, LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }] }],
  }
  const res = await qbPost(credentials, '/payment', payload)
  return res?.Payment
}

async function testConnection(credentials) {
  try {
    await runQuery(credentials, 'SELECT COUNT(*) FROM Customer MAXRESULTS 1')
    return { valid: true }
  } catch (err) {
    const detail = err.response?.data?.Fault?.Error?.[0]?.Detail || err.message
    return { valid: false, error: detail }
  }
}

module.exports = { getCustomer, getInvoices, createInvoice, getAccountBalance, registerPayment, testConnection }
