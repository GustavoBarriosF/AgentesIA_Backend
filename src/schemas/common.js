'use strict'

// ─── Fragmentos de schema reutilizables en todas las rutas ────────────────────

/** Param :workspaceId presente en todas las rutas /api/:workspaceId/... */
const workspaceParam = {
  type: 'object',
  required: ['workspaceId'],
  properties: {
    workspaceId: { type: 'string', description: 'ID del workspace (MongoDB ObjectId)' },
  },
}

/** Paginación estándar: ?page=1&limit=20 */
const paginationQuery = {
  page: { type: 'integer', default: 1, minimum: 1, description: 'Número de página' },
  limit: { type: 'integer', default: 20, minimum: 1, maximum: 100, description: 'Resultados por página' },
}

/** Respuesta de error genérica */
const errorResponse = {
  type: 'object',
  properties: {
    error: { type: 'string', description: 'Mensaje de error' },
  },
}

/** Respuesta de error con detalle de validación */
const validationError = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    details: { type: 'array', items: { type: 'object' } },
  },
}

/** Security scheme para rutas protegidas con JWT */
const security = [{ BearerAuth: [] }]

/** Tipo MongoDB ObjectId como string */
const objectId = { type: 'string', description: 'MongoDB ObjectId (24 hex chars)' }

/** Timestamps de Mongoose */
const timestamps = {
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
}

module.exports = {
  workspaceParam,
  paginationQuery,
  errorResponse,
  validationError,
  security,
  objectId,
  timestamps,
}
