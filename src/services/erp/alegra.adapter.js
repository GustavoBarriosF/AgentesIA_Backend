'use strict'

const axios = require('axios')
const logger = require('../../utils/logger')

const ALEGRA_BASE = 'https://app.alegra.com/api/v1'

function headers(credentials) {
  const b64 = Buffer.from(`${credentials.email}:${credentials.token}`).toString('base64')
  return { Authorization: `Basic ${b64}`, 'Content-Type': 'application/json' }
}

async function apiCall(credentials, method, path, params = null, data = null) {
  try {
    const res = await axios({ method, url: `${ALEGRA_BASE}${path}`, params, data, headers: headers(credentials) })
    return res.data
  } catch (err) {
    logger.error({ err: err.response?.data }, `[Alegra] ${method} ${path} error`)
    throw err
  }
}

async function getCustomer(credentials, identifier) {
  // Search by identification number
  const res = await apiCall(credentials, 'GET', '/contacts', { identification: identifier, type: 'client', limit: 1 })
  const list = Array.isArray(res) ? res : []
  if (list.length) return list[0]
  // Fallback: search by name
  const res2 = await apiCall(credentials, 'GET', '/contacts', { name: identifier, type: 'client', limit: 1 })
  return (Array.isArray(res2) ? res2 : [])[0] || null
}

async function getInvoices(credentials, customerId, filters = {}) {
  const res = await apiCall(credentials, 'GET', '/invoices', { client: customerId, ...filters })
  return Array.isArray(res) ? res : []
}

async function createInvoice(credentials, data) {
  return apiCall(credentials, 'POST', '/invoices', null, data)
}

async function getAccountBalance(credentials, customerId) {
  const invoices = await getInvoices(credentials, customerId, { type: 'invoice', status: 'open' })
  const total = invoices.reduce((sum, inv) => sum + (parseFloat(inv.balance) || 0), 0)
  return { customer_id: customerId, total_balance: total, pending_count: invoices.length, invoices: invoices.slice(0, 10) }
}

async function registerPayment(credentials, invoiceId, data) {
  return apiCall(credentials, 'POST', '/payments', null, { invoices: [{ id: invoiceId, ...data }] })
}

async function testConnection(credentials) {
  try {
    await apiCall(credentials, 'GET', '/contacts', { limit: 1 })
    return { valid: true }
  } catch (err) {
    return { valid: false, error: err.response?.data?.message || err.message }
  }
}

module.exports = { getCustomer, getInvoices, createInvoice, getAccountBalance, registerPayment, testConnection }
