'use strict'

/**
 * rag.service.js  –  Retrieval-Augmented Generation
 *
 * Flujo completo:
 *   1. indexItem()   → texto → chunks → embeddings (Ollama) → Qdrant
 *   2. searchRAG()   → query → embedding → Qdrant search → contexto relevante
 *   3. deleteItem()  → elimina todos los chunks de un item de Qdrant
 *
 * Variables de entorno:
 *   OLLAMA_URL         URL del servidor Ollama
 *   OLLAMA_EMBED_MODEL Modelo de embeddings (default: llama3.2:1b)
 *   QDRANT_URL         URL de Qdrant
 *   QDRANT_API_KEY     API Key de Qdrant
 */

const { generateEmbedding } = require('./llm/ollama.adapter')
const qdrant                = require('./qdrant.service')
const KnowledgeItem         = require('../db/models/knowledge-item')
const logger                = require('../utils/logger')

// ─── Configuración de chunking ────────────────────────────────────────────────
const CHUNK_SIZE    = 1200  // caracteres objetivo por chunk
const CHUNK_OVERLAP = 200   // solapamiento entre chunks para mantener contexto

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Divide texto en chunks respetando límites de párrafo → oración → palabra.
 * Nunca corta a mitad de palabra. Tamaño objetivo CHUNK_SIZE caracteres.
 * @param {string} text
 * @returns {string[]}
 */
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (!text || text.length === 0) return []

  // Normalizar saltos de línea múltiples
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n')

  // Dividir primero en párrafos (doble salto de línea)
  const paragraphs = normalized.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0)

  const chunks  = []
  let current   = ''

  for (const para of paragraphs) {
    // Si el párrafo solo es demasiado grande, dividirlo en oraciones
    if (para.length > size * 1.5) {
      // Primero vaciar el buffer actual
      if (current.trim().length > 50) {
        chunks.push(current.trim())
        // Mantener solapamiento: últimas palabras del chunk anterior
        current = getOverlap(current, overlap)
      }
      // Dividir párrafo largo en oraciones
      const sentences = para.match(/[^.!?\n]+[.!?\n]+/g) || [para]
      for (const sentence of sentences) {
        if ((current + ' ' + sentence).length <= size) {
          current = current ? current + ' ' + sentence.trim() : sentence.trim()
        } else {
          if (current.trim().length > 50) {
            chunks.push(current.trim())
            current = getOverlap(current, overlap) + ' ' + sentence.trim()
          } else {
            current = sentence.trim()
          }
        }
      }
    } else if ((current + '\n\n' + para).length <= size) {
      // El párrafo cabe en el chunk actual
      current = current ? current + '\n\n' + para : para
    } else {
      // No cabe — cerrar chunk actual y empezar uno nuevo
      if (current.trim().length > 50) {
        chunks.push(current.trim())
        current = getOverlap(current, overlap) + '\n\n' + para
      } else {
        current = para
      }
    }
  }

  // Último chunk pendiente
  if (current.trim().length > 50) {
    chunks.push(current.trim())
  }

  return chunks.filter(c => c.length > 30)
}

/**
 * Extrae las últimas ~overlap caracteres del texto respetando límite de palabra.
 */
function getOverlap(text, overlap) {
  if (text.length <= overlap) return text
  const slice = text.slice(-overlap)
  const firstSpace = slice.indexOf(' ')
  return firstSpace > 0 ? slice.slice(firstSpace + 1) : slice
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Indexa un KnowledgeItem en Qdrant.
 * - Divide el contenido en chunks
 * - Genera embeddings con Ollama
 * - Hace upsert en Qdrant
 * - Marca el item como indexado en MongoDB
 *
 * @param {string} workspaceId
 * @param {string} knowledgeItemId
 * @param {string} content
 * @param {string} [title]
 * @param {string} [embedModel]  Override del modelo de embeddings
 * @returns {Promise<{ chunks: number, skipped: number }>}
 */
async function indexItem(workspaceId, knowledgeItemId, content, title = '', embedModel) {
  const resolvedEmbedModel = embedModel || process.env.OLLAMA_EMBED_MODEL || 'llama3.2:1b'

  const chunks = chunkText(content)
  if (!chunks.length) {
    logger.warn({ knowledgeItemId }, '[RAG] Item sin texto para indexar')
    return { chunks: 0, skipped: 0 }
  }

  const points  = []
  let   skipped = 0

  // Probar embedding con el primer chunk para detectar problemas rápido
  logger.info({ embedModel: resolvedEmbedModel, ollamaUrl: process.env.OLLAMA_URL, totalChunks: chunks.length }, '[RAG] Iniciando indexación')

  for (let i = 0; i < chunks.length; i++) {
    const vector = await generateEmbedding(chunks[i], resolvedEmbedModel)
    if (!vector.length) {
      if (i === 0) {
        // Si el primer chunk falla, los demás también fallarán — abortar
        logger.error({
          knowledgeItemId,
          embedModel: resolvedEmbedModel,
          ollamaUrl: process.env.OLLAMA_URL,
          chunkPreview: chunks[0].slice(0, 100),
        }, '[RAG] Fallo en embedding del primer chunk — abortando indexación. Verifica OLLAMA_URL y el modelo.')
        await KnowledgeItem.findByIdAndUpdate(knowledgeItemId, {
          $set: { rag_indexed: false, rag_chunks: 0 },
        })
        return { chunks: 0, skipped: chunks.length, error: 'Embedding falló — verifica Ollama' }
      }
      skipped++
      continue
    }
    points.push({
      knowledgeItemId: knowledgeItemId.toString(),
      chunkIndex:      i,
      vector,
      payload: {
        text:  chunks[i],
        title,
      },
    })
  }

  if (points.length > 0) {
    await qdrant.upsertChunks(workspaceId, points)
  }

  // Marcar como indexado en MongoDB
  await KnowledgeItem.findByIdAndUpdate(knowledgeItemId, {
    $set: {
      rag_indexed:    points.length > 0,
      rag_chunks:     points.length,
      rag_indexed_at: new Date(),
    },
  })

  logger.info({ knowledgeItemId, chunks: points.length, skipped }, '[RAG] Item indexado')
  return { chunks: points.length, skipped }
}

/**
 * Busca los chunks más relevantes para una consulta.
 * Combina resultados de Qdrant (semántico) con fallback a texto plano.
 *
 * @param {string}   workspaceId
 * @param {string}   query
 * @param {{
 *   topK?:           number,
 *   filterItemIds?:  string[],
 *   scoreThreshold?: number,
 *   embedModel?:     string,
 * }} opts
 * @returns {Promise<Array<{ text: string, knowledge_item_id: string, score: number, title: string }>>}
 */
async function searchRAG(workspaceId, query, opts = {}) {
  const {
    topK           = 5,
    filterItemIds  = null,
    scoreThreshold = 0.4,
    embedModel,
  } = opts

  const resolvedEmbedModel = embedModel || process.env.OLLAMA_EMBED_MODEL || 'llama3.2:1b'

  const queryVector = await generateEmbedding(query, resolvedEmbedModel)
  if (!queryVector.length) {
    logger.warn({ workspaceId }, '[RAG] No se pudo generar embedding para la consulta')
    return []
  }

  const results = await qdrant.searchChunks(workspaceId, queryVector, {
    topK,
    filterItemIds,
    scoreThreshold,
  })

  return results.map(r => ({
    text:              r.payload.text,
    knowledge_item_id: r.payload.knowledge_item_id,
    title:             r.payload.title || '',
    score:             r.score,
    chunk_index:       r.payload.chunk_index,
  }))
}

/**
 * Recupera los primeros chunks del documento (protocolo/apertura) por item IDs.
 * No usa búsqueda vectorial — garantiza que el protocolo siempre esté en contexto.
 * @param {string}   workspaceId
 * @param {string[]} itemIds
 * @returns {Promise<Array<{ text: string, knowledge_item_id: string, chunk_index: number, title: string }>>}
 */
async function getProtocolChunks(workspaceId, itemIds) {
  const points = await qdrant.getFirstChunks(workspaceId, itemIds, 2)
  return points.map(p => ({
    text:              p.payload.text,
    knowledge_item_id: p.payload.knowledge_item_id,
    chunk_index:       p.payload.chunk_index,
    title:             p.payload.title || '',
  }))
}

/**
 * Elimina los vectores de un item de Qdrant y limpia el flag en MongoDB.
 */
async function deleteItemVectors(workspaceId, knowledgeItemId) {
  await qdrant.deleteItemChunks(workspaceId, knowledgeItemId)
  await KnowledgeItem.findByIdAndUpdate(knowledgeItemId, {
    $set: { rag_indexed: false, rag_chunks: 0 },
  })
}

/**
 * Re-indexa todos los items de un workspace.
 * Útil cuando el workspace cambia de modelo de embeddings.
 */
async function reindexWorkspace(workspaceId, embedModel) {
  const items = await KnowledgeItem.find({ workspace_id: workspaceId, active: true }).lean()
  let indexed = 0
  let failed  = 0

  for (const item of items) {
    try {
      // Primero borrar los vectores existentes
      await qdrant.deleteItemChunks(workspaceId, item._id)
      await indexItem(workspaceId, item._id, item.content, item.title, embedModel)
      indexed++
    } catch (err) {
      logger.error({ err: err.message, itemId: item._id }, '[RAG] Error re-indexando item')
      failed++
    }
  }

  logger.info({ workspaceId, indexed, failed }, '[RAG] Re-indexación completada')
  return { indexed, failed, total: items.length }
}

module.exports = { indexItem, searchRAG, getProtocolChunks, deleteItemVectors, reindexWorkspace, chunkText }
