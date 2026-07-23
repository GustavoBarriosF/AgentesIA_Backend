'use strict'

/**
 * Normaliza un numero de telefono removiendo caracteres no numericos
 * y asegurando formato internacional
 */
function normalizePhone(phone) {
  if (!phone) return null
  return phone.replace(/[^\d+]/g, '')
}

/**
 * Genera un slug URL-seguro desde un string
 */
function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remover acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Parsea paginacion de query params
 */
function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20))
  return { page, limit, skip: (page - 1) * limit }
}

/**
 * Formatea segundos en formato legible HH:MM:SS
 */
function formatDuration(seconds) {
  if (!seconds) return '0s'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * Genera un código numérico corto único (entre min y max) que no exista
 * en la colección dada. Reintenta hasta 20 veces antes de lanzar error.
 * @param {Model} Model  - Modelo Mongoose donde verificar unicidad
 * @param {string} field - Nombre del campo a chequear (ej: 'ticket_number')
 * @param {Object} extraQuery - Filtros adicionales (ej: { workspace_id })
 * @param {number} min - Valor mínimo inclusivo
 * @param {number} max - Valor máximo inclusivo
 */
async function generateUniqueCode(Model, field, extraQuery = {}, min = 10000, max = 99999999) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = Math.floor(Math.random() * (max - min + 1)) + min
    const exists = await Model.exists({ [field]: code, ...extraQuery })
    if (!exists) return code
  }
  throw new Error(`No se pudo generar un código único para ${field} después de 20 intentos`)
}

module.exports = { normalizePhone, slugify, parsePagination, formatDuration, generateUniqueCode }
