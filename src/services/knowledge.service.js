'use strict'

/**
 * knowledge.service.js
 *
 * Gestión de la base de conocimiento con RAG (Qdrant + Ollama embeddings).
 *
 * Búsqueda:
 *   1. Intenta primero búsqueda vectorial en Qdrant (semántica, alta calidad)
 *   2. Si Qdrant no tiene vectores (item no indexado), cae back a cosine similarity
 *      usando los embeddings almacenados en MongoDB (compatibilidad hacia atrás)
 *   3. Si ninguno tiene embeddings, devuelve los primeros ítems activos (fallback texto)
 *
 * Indexación automática:
 *   - Al crear/actualizar un item se dispara indexItem() en Qdrant (fire-and-forget)
 *   - El flag rag_indexed en MongoDB indica si el item ya está en Qdrant
 */

const KnowledgeItem = require('../db/models/knowledge-item')
const ragService    = require('./rag.service')
const logger        = require('../utils/logger')

// ─── Keyword search (extrae fragmento relevante del contenido) ───────────────

/**
 * Busca el texto de la consulta literalmente en los ítems de MongoDB.
 * Extrae un fragmento de ~600 chars centrado en la primera coincidencia.
 * @param {object}   mongoQuery  Filtro de MongoDB ya construido
 * @param {string}   text        Consulta del usuario
 * @param {number}   topK
 * @returns {Promise<Array<{ item: object, score: number }>>}
 */
/**
 * Convierte una palabra en regex que matchea tanto con acento como sin acento.
 * "perdida" → "p[eéèêë]rdid[aáàâä]"
 */
function accentInsensitive(word) {
  return word
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escapar regex primero
    .replace(/[aáàâä]/gi, '[aáàâä]')
    .replace(/[eéèêë]/gi, '[eéèêë]')
    .replace(/[iíìîï]/gi, '[iíìîï]')
    .replace(/[oóòôö]/gi, '[oóòôö]')
    .replace(/[uúùûü]/gi, '[uúùûü]')
    .replace(/[nñ]/gi,    '[nñ]')
}

async function keywordSearch(mongoQuery, text, topK) {
  // Extraer palabras clave significativas (>3 chars)
  const words = text.trim().split(/\s+/).filter(w => w.length > 3)
  if (!words.length) return []

  // Regex insensible a acentos: "perdida" matchea "pérdida" y viceversa
  const regex = words.map(accentInsensitive).join('|')
  const items = await KnowledgeItem.find({
    ...mongoQuery,
    content: { $regex: regex, $options: 'i' },
  }).lean()

  // Normalizar texto: quitar acentos para búsqueda de posición
  function normalize(str) {
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  }

  const results = []
  for (const item of items) {
    const content    = item.content || ''
    const normContent = normalize(content)
    const normQuery  = normalize(text)

    // Buscar la mejor posición: primero frase completa, luego palabras individuales
    let pos = normContent.indexOf(normQuery)
    if (pos === -1) {
      for (const word of words) {
        const idx = normContent.indexOf(normalize(word))
        if (idx !== -1) { pos = idx; break }
      }
    }
    if (pos === -1) continue

    // Extraer ventana de 600 chars alrededor de la coincidencia
    const start   = Math.max(0, pos - 100)
    const end     = Math.min(content.length, pos + 500)
    const excerpt = content.slice(start, end).trim()

    results.push({
      item: {
        _id:     item._id,
        title:   item.title,
        content: excerpt,
        type:    item.type,
        active:  item.active,
      },
      score: 0.5, // score fijo para resultados de keyword (por debajo del semántico)
    })

    if (results.length >= topK) break
  }

  return results
}

// ─── Cosine similarity (fallback) ────────────────────────────────────────────

function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

async function listItems(workspaceId, { includeInactive = false } = {}) {
  const query = { workspace_id: workspaceId }
  if (!includeInactive) query.active = true
  return KnowledgeItem.find(query).lean()
}

async function createItem(workspaceId, { type, title, content, confidence_threshold, tags }) {
  const item = await KnowledgeItem.create({
    workspace_id:         workspaceId,
    type:                 type || 'faq',
    title,
    content,
    embedding:            [],
    confidence_threshold: confidence_threshold ?? 0.75,
    tags:                 tags || [],
  })

  // Indexar en Qdrant en background (no bloquear la respuesta)
  ragService.indexItem(workspaceId, item._id, content, title)
    .catch(err => logger.error({ err: err.message, itemId: item._id }, '[Knowledge] Error indexando en Qdrant'))

  return item
}

async function updateItem(workspaceId, itemId, data) {
  const item = await KnowledgeItem.findOneAndUpdate(
    { _id: itemId, workspace_id: workspaceId },
    { $set: data },
    { new: true }
  )
  if (!item) throw Object.assign(new Error('Item no encontrado'), { statusCode: 404 })

  // Re-indexar si cambió el contenido
  if (data.content || data.title) {
    ragService.deleteItemVectors(workspaceId, itemId)
      .then(() => ragService.indexItem(workspaceId, itemId, item.content, item.title))
      .catch(err => logger.error({ err: err.message, itemId }, '[Knowledge] Error re-indexando'))
  }

  return item
}

async function deleteItem(workspaceId, itemId) {
  // Hard delete: elimina físicamente de MongoDB
  await KnowledgeItem.findOneAndDelete({ _id: itemId, workspace_id: workspaceId })
  // Eliminar vectores de Qdrant en background
  ragService.deleteItemVectors(workspaceId, itemId)
    .catch(err => logger.error({ err: err.message, itemId }, '[Knowledge] Error borrando vectores'))
}

async function deactivateItem(workspaceId, itemId) {
  // Soft delete: solo desactiva (para el toggle activo/inactivo)
  const item = await KnowledgeItem.findOneAndUpdate(
    { _id: itemId, workspace_id: workspaceId },
    { $set: { active: false } },
    { new: true }
  )
  if (!item) throw Object.assign(new Error('Item no encontrado'), { statusCode: 404 })
  return item
}

// ─── Búsqueda semántica ───────────────────────────────────────────────────────

/**
 * Busca los top-k ítems más relevantes para una consulta.
 *
 * Estrategia:
 *   1. RAG via Qdrant (si Ollama está configurado)
 *   2. Fallback: cosine similarity con embeddings de MongoDB
 *   3. Último fallback: primeros N ítems activos
 *
 * @param {string} workspaceId
 * @param {string} text
 * @param {{ topK?: number, filterIds?: string[]|ObjectId[] }} options
 * @returns {Promise<Array<{ item: object, score: number }>>}
 */
async function searchRelevant(workspaceId, text, options = {}) {
  // Compatibilidad con llamada antigua: searchRelevant(wid, text, 3)
  const topK         = typeof options === 'number' ? options : (options.topK         ?? 3)
  const filterIds    = typeof options === 'object'            ? (options.filterIds    ?? null) : null
  // keywordQuery permite usar un texto distinto para la búsqueda por palabras clave
  // (útil cuando text es una query semántica larga que incluye contexto conversacional)
  const keywordQuery = typeof options === 'object'            ? (options.keywordQuery ?? text) : text

  const query = { workspace_id: workspaceId, active: true }
  if (filterIds?.length) query._id = { $in: filterIds }

  // ── 1. Intentar RAG via Qdrant ──────────────────────────────────────────
  if (process.env.OLLAMA_URL) {
    try {
      // Umbral bajo porque llama3.2:1b produce similitudes en rango 0.05–0.30
      const ragResults = await ragService.searchRAG(workspaceId, text, {
        topK:           topK * 3, // pedir más para luego filtrar los mejores por item
        filterItemIds:  filterIds?.map(id => id.toString()) ?? null,
        scoreThreshold: 0.05,    // muy permisivo — el ranking se encarga de la relevancia
      })

      logger.debug({ workspaceId, results: ragResults.length, scores: ragResults.map(r => r.score.toFixed(3)) }, '[Knowledge] RAG resultados')

      if (ragResults.length > 0) {
        // IMPORTANTE: usar el TEXTO DEL CHUNK (no el documento completo)
        // Agrupar: tomar los top-topK chunks con mayor score, sin repetir item
        const seen  = new Set()
        const final = []

        for (const r of ragResults) {
          // Crear un item virtual con solo el fragmento relevante del chunk
          const chunkItem = {
            _id:     r.knowledge_item_id,
            title:   r.title || '',
            content: r.text,  // ← CHUNK TEXT, no documento completo
            type:    'document',
            active:  true,
          }
          final.push({ item: chunkItem, score: r.score })
          if (final.length >= topK) break
        }

        if (final.length > 0) {
          // Búsqueda híbrida: agregar keyword results que tengan CONTENIDO distinto
          // No deduplicar por _id porque RAG y keyword del mismo doc tienen diferente texto
          const ragTexts = new Set(final.map(r => r.item.content?.slice(0, 60)))
          const kwResults = await keywordSearch(query, keywordQuery, topK)
          for (const kw of kwResults) {
            const preview = kw.item.content?.slice(0, 60)
            if (!ragTexts.has(preview) && final.length < topK + 3) {
              final.push(kw)
              logger.debug({ workspaceId, preview }, '[Knowledge] Keyword hit agregado')
            }
          }

          logger.info({ workspaceId, chunks: final.length, topScore: final[0].score }, '[Knowledge] RAG + keyword exitoso')
          return final
        }

        // RAG devolvió 0 resultados — usar solo keyword search
        logger.debug({ workspaceId }, '[Knowledge] RAG sin resultados, usando keyword search')
        const kwOnly = await keywordSearch(query, keywordQuery, topK)
        if (kwOnly.length > 0) {
          logger.info({ workspaceId, hits: kwOnly.length }, '[Knowledge] Keyword search exitoso')
          return kwOnly
        }
      }
    } catch (err) {
      logger.warn({ err: err.message, workspaceId }, '[Knowledge] RAG falló, usando fallback')
    }
  }

  // Sin Ollama: intentar keyword search directamente
  if (!process.env.OLLAMA_URL) {
    const kwResults = await keywordSearch(query, keywordQuery, topK)
    if (kwResults.length > 0) return kwResults
  }

  // ── 2. Fallback: cosine similarity con embeddings de MongoDB ────────────
  const items = await KnowledgeItem.find(query).lean()

  const hasEmbeddings = items.some(i => i.embedding?.length > 0)
  if (hasEmbeddings) {
    // Generar embedding de la consulta usando Ollama si está disponible
    let queryEmbedding = []
    if (process.env.OLLAMA_URL) {
      const { generateEmbedding } = require('./llm/ollama.adapter')
      queryEmbedding = await generateEmbedding(text).catch(() => [])
    }

    if (queryEmbedding.length > 0) {
      return items
        .map(item => ({ item, score: cosineSimilarity(queryEmbedding, item.embedding) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
    }
  }

  // ── 3. Último fallback: primeros N ítems (con contenido truncado) ───────
  // Limitamos el contenido para no abrumar el contexto del LLM
  logger.debug({ workspaceId }, '[Knowledge] Sin embeddings, usando fallback texto')
  const MAX_CHARS_PER_ITEM = 2000
  return items.slice(0, topK).map(item => ({
    item: {
      ...item,
      content: item.content.length > MAX_CHARS_PER_ITEM
        ? item.content.slice(0, MAX_CHARS_PER_ITEM) + '\n[... contenido truncado ...]'
        : item.content,
    },
    score: 0,
  }))
}

/**
 * Devuelve el contenido COMPLETO de los ítems asignados al bot.
 * Usado cuando el documento es pequeño (<= maxChars) y conviene pasar
 * todo el texto en vez de buscar chunks (evita fallos de RAG).
 *
 * @param {string}   workspaceId
 * @param {string[]} itemIds      IDs de los knowledge items del bot
 * @param {number}   maxChars     Límite total de caracteres (default 20000)
 * @returns {Promise<{ context: string, itemIds: string[], truncated: boolean }>}
 */
async function getFullContext(workspaceId, itemIds, maxChars = 20000) {
  const items = await KnowledgeItem.find({
    workspace_id: workspaceId,
    active:       true,
    _id:          { $in: itemIds },
  }).lean()

  let context   = ''
  let truncated = false

  for (const item of items) {
    const label = item.type === 'spreadsheet' ? ' [Excel]' : ''
    const section = `## ${item.title}${label}\n\n${item.content}\n\n`
    if (context.length + section.length > maxChars) {
      const remaining = maxChars - context.length
      if (remaining > 300) {
        context  += section.slice(0, remaining) + '\n[... documento truncado ...]'
        truncated = true
      }
      break
    }
    context += section
  }

  return {
    context:  context.trim(),
    itemIds:  items.map(i => i._id),
    truncated,
  }
}

async function incrementUsage(itemId) {
  await KnowledgeItem.findByIdAndUpdate(itemId, { $inc: { usage_count: 1 } })
}

module.exports = {
  listItems,
  createItem,
  updateItem,
  deleteItem,
  deactivateItem,
  searchRelevant,
  getFullContext,
  incrementUsage,
}
