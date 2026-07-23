'use strict'

/**
 * qdrant.service.js  –  Cliente HTTP para Qdrant
 *
 * Variables de entorno:
 *   QDRANT_URL      URL base de Qdrant (default: http://localhost:6333)
 *   QDRANT_API_KEY  API key de Qdrant (requerida en producción)
 *
 * Cada workspace tiene su propia colección: `ws_<workspaceId>`
 * Vectores: distancia Cosine, tamaño dinámico (se detecta del primer punto)
 */

const axios  = require('axios')
const crypto = require('crypto')
const logger = require('../utils/logger')

const COLLECTION_PREFIX = 'ws_'

// ─── Helpers internos ────────────────────────────────────────────────────────

function getClient() {
  const baseURL = (process.env.QDRANT_URL || 'http://localhost:6333').replace(/\/$/, '')
  const headers = { 'Content-Type': 'application/json' }
  if (process.env.QDRANT_API_KEY) {
    headers['api-key'] = process.env.QDRANT_API_KEY
  }
  return axios.create({ baseURL, headers, timeout: 30_000 })
}

function collectionName(workspaceId) {
  return `${COLLECTION_PREFIX}${workspaceId.toString()}`
}

/**
 * Genera un ID UUID determinístico para un chunk.
 * knowledgeItemId + chunkIndex → mismo UUID siempre (para re-indexar sin duplicar)
 */
function chunkPointId(knowledgeItemId, chunkIndex) {
  const hash = crypto
    .createHash('md5')
    .update(`${knowledgeItemId}-${chunkIndex}`)
    .digest('hex')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join('-')
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Crea la colección del workspace si no existe.
 * @param {string} workspaceId
 * @param {number} vectorSize  Dimensión del embedding (ej. 2048 para llama3.2:1b)
 */
async function ensureCollection(workspaceId, vectorSize) {
  const client = getClient()
  const name   = collectionName(workspaceId)

  try {
    await client.get(`/collections/${name}`)
    return // ya existe
  } catch (err) {
    if (err.response?.status !== 404) throw err
  }

  // Crear colección
  await client.put(`/collections/${name}`, {
    vectors: {
      size:     vectorSize,
      distance: 'Cosine',
    },
    optimizers_config: { indexing_threshold: 0 },
  })

  // Índice de payload para filtrar por knowledge_item_id
  await client.put(`/collections/${name}/index`, {
    field_name: 'knowledge_item_id',
    field_schema: 'keyword',
  }).catch(() => {}) // ignorar si ya existe

  logger.info({ name, vectorSize }, '[Qdrant] Colección creada')
}

/**
 * Inserta o actualiza vectores en la colección del workspace.
 * @param {string} workspaceId
 * @param {Array<{ knowledgeItemId: string, chunkIndex: number, vector: number[], payload: object }>} chunks
 */
async function upsertChunks(workspaceId, chunks) {
  if (!chunks.length) return

  const vectorSize = chunks[0].vector.length
  await ensureCollection(workspaceId, vectorSize)

  const client = getClient()
  const name   = collectionName(workspaceId)

  const points = chunks.map(c => ({
    id:      chunkPointId(c.knowledgeItemId, c.chunkIndex),
    vector:  c.vector,
    payload: {
      knowledge_item_id: c.knowledgeItemId.toString(),
      workspace_id:      workspaceId.toString(),
      chunk_index:       c.chunkIndex,
      text:              c.payload.text,
      title:             c.payload.title || '',
      ...c.payload,
    },
  }))

  await client.put(`/collections/${name}/points`, { points })
  logger.debug({ workspaceId, count: points.length }, '[Qdrant] Chunks insertados')
}

/**
 * Busca los chunks más similares a un vector de consulta.
 * @param {string}   workspaceId
 * @param {number[]} queryVector
 * @param {{
 *   topK?:           number,
 *   filterItemIds?:  string[],
 *   scoreThreshold?: number
 * }} opts
 * @returns {Promise<Array<{ score: number, payload: object }>>}
 */
async function searchChunks(workspaceId, queryVector, opts = {}) {
  const { topK = 5, filterItemIds = null, scoreThreshold = 0.4 } = opts
  const client = getClient()
  const name   = collectionName(workspaceId)

  const body = {
    vector:          queryVector,
    limit:           topK,
    score_threshold: scoreThreshold,
    with_payload:    true,
  }

  if (filterItemIds?.length) {
    body.filter = {
      must: [{
        key:   'knowledge_item_id',
        match: { any: filterItemIds.map(id => id.toString()) },
      }],
    }
  }

  try {
    const res = await client.post(`/collections/${name}/points/search`, body)
    const results = res.data?.result || []
    logger.debug({
      workspaceId,
      collection: name,
      scoreThreshold,
      filterItemIds: filterItemIds ?? 'none',
      resultCount: results.length,
      scores: results.map(r => r.score?.toFixed(4)),
    }, '[Qdrant] Resultado de búsqueda')
    return results
  } catch (err) {
    if (err.response?.status === 404) {
      logger.warn({ workspaceId, collection: name }, '[Qdrant] Colección no existe todavía')
      return []
    }
    logger.error({ err: err.message, status: err.response?.status, data: err.response?.data, workspaceId }, '[Qdrant] Error en búsqueda')
    return []
  }
}

/**
 * Recupera los primeros N chunks de una lista de items sin búsqueda vectorial.
 * Usado para inyectar siempre el protocolo/apertura del documento en el contexto.
 * @param {string}   workspaceId
 * @param {string[]} itemIds
 * @param {number}   maxChunkIndex  Recupera chunks con chunk_index <= maxChunkIndex
 */
async function getFirstChunks(workspaceId, itemIds, maxChunkIndex = 2) {
  if (!itemIds?.length) return []
  const client = getClient()
  const name   = collectionName(workspaceId)

  try {
    const res = await client.post(`/collections/${name}/points/scroll`, {
      filter: {
        must: [
          { key: 'knowledge_item_id', match: { any: itemIds.map(id => id.toString()) } },
          { key: 'chunk_index', range: { lte: maxChunkIndex } },
        ],
      },
      limit: itemIds.length * (maxChunkIndex + 1),
      with_payload: true,
      with_vectors: false,
    })
    return (res.data?.result?.points || [])
      .sort((a, b) => {
        const iA = a.payload.knowledge_item_id + a.payload.chunk_index
        const iB = b.payload.knowledge_item_id + b.payload.chunk_index
        return iA < iB ? -1 : iA > iB ? 1 : 0
      })
  } catch (err) {
    if (err.response?.status !== 404) {
      logger.warn({ err: err.message }, '[Qdrant] Error recuperando primeros chunks')
    }
    return []
  }
}

/**
 * Elimina todos los vectores de un knowledge item (útil al actualizar/eliminar).
 * @param {string} workspaceId
 * @param {string} knowledgeItemId
 */
async function deleteItemChunks(workspaceId, knowledgeItemId) {
  const client = getClient()
  const name   = collectionName(workspaceId)

  try {
    await client.post(`/collections/${name}/points/delete`, {
      filter: {
        must: [{
          key:   'knowledge_item_id',
          match: { value: knowledgeItemId.toString() },
        }],
      },
    })
  } catch (err) {
    if (err.response?.status !== 404) {
      logger.error({ err: err.message, knowledgeItemId }, '[Qdrant] Error eliminando chunks')
    }
  }
}

/**
 * Verifica conectividad con Qdrant.
 * @returns {Promise<boolean>}
 */
async function ping() {
  try {
    const client = getClient()
    await client.get('/healthz', { timeout: 5_000 })
    return true
  } catch {
    return false
  }
}

module.exports = { ensureCollection, upsertChunks, searchChunks, getFirstChunks, deleteItemChunks, ping, chunkPointId }
