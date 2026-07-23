'use strict'

const knowledgeService = require('../../services/knowledge.service')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

/**
 * Convierte un buffer de Excel (.xlsx/.xls) en texto estructurado.
 * Cada hoja se renderiza como una tabla markdown con su nombre como encabezado.
 */
function parseExcelToText(buffer, fileName) {
  const XLSX = require('xlsx')
  const workbook = XLSX.read(buffer, { type: 'buffer' })

  const sections = [`Libro: ${fileName}\n`]

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })

    // Ignorar hojas completamente vacías
    const nonEmpty = rows.filter(r => r.some(cell => String(cell).trim() !== ''))
    if (nonEmpty.length === 0) continue

    sections.push(`### Hoja: ${sheetName}`)

    // Calcular ancho máximo de columnas para alinear
    const maxCols = Math.max(...nonEmpty.map(r => r.length))
    for (const row of nonEmpty) {
      const cells = Array.from({ length: maxCols }, (_, i) => String(row[i] ?? '').trim())
      sections.push(`| ${cells.join(' | ')} |`)
    }

    sections.push('')
  }

  return sections.join('\n')
}

// Añadimos los campos RAG al schema de respuesta

const KnowledgeItemObject = {
  type: 'object',
  properties: {
    _id:                  { type: 'string' },
    workspace_id:         { type: 'string' },
    type:                 { type: 'string', enum: ['faq', 'document', 'flow', 'snippet', 'spreadsheet'] },
    title:                { type: 'string' },
    content:              { type: 'string', description: 'Contenido de la respuesta o documento' },
    confidence_threshold: { type: 'number', minimum: 0, maximum: 1, description: 'Umbral mínimo de similitud para usar este ítem' },
    active:               { type: 'boolean' },
    tags:                 { type: 'array', items: { type: 'string' } },
    usage_count:          { type: 'integer', description: 'Veces que el bot usó este ítem' },
    helpful_count:        { type: 'integer', description: 'Feedback positivo' },
    unhelpful_count:      { type: 'integer', description: 'Feedback negativo' },
    rag_indexed:          { type: 'boolean', description: 'True si está indexado en Qdrant para búsqueda semántica' },
    rag_chunks:           { type: 'integer', description: 'Número de chunks en Qdrant' },
    rag_indexed_at:       { type: 'string', format: 'date-time', nullable: true, description: 'Última vez indexado' },
    createdAt:            { type: 'string', format: 'date-time' },
    updatedAt:            { type: 'string', format: 'date-time' },
  },
}

async function knowledgeRoutes(fastify) {
  const preHandler  = [fastify.authenticate, fastify.requireWorkspace]
  const adminHandler = [...preHandler, fastify.requireRole('admin')]

  // ─── GET /api/:workspaceId/knowledge ──────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Knowledge'],
      summary: 'Listar base de conocimiento',
      description: 'Retorna los ítems de conocimiento del workspace. Por defecto solo retorna los activos.',
      security,
      params: workspaceParam,
      querystring: {
        type: 'object',
        properties: {
          include_inactive: { type: 'boolean', default: false, description: 'Si true, incluye ítems desactivados' },
        },
      },
      response: {
        200: { description: 'Lista de ítems', type: 'array', items: KnowledgeItemObject },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const includeInactive = request.query.include_inactive === true || request.query.include_inactive === 'true'
    return knowledgeService.listItems(request.workspaceId, { includeInactive })
  })

  // ─── GET /api/:workspaceId/knowledge/search ───────────────────────────────
  fastify.get('/search', {
    preHandler,
    schema: {
      tags: ['Knowledge'],
      summary: 'Buscar en la base de conocimiento',
      description: 'Busca ítems relevantes usando similitud semántica (embeddings). Útil para probar qué respondería el bot ante una pregunta.',
      security,
      params: workspaceParam,
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q: { type: 'string', description: 'Pregunta o texto a buscar', example: '¿Cuáles son sus horarios de atención?' },
        },
      },
      response: {
        200: {
          description: 'Ítems relevantes con score de similitud',
          type: 'array',
          items: {
            allOf: [
              KnowledgeItemObject,
              {
                type: 'object',
                properties: {
                  similarity_score: { type: 'number', minimum: 0, maximum: 1, description: 'Score de similitud semántica' },
                },
              },
            ],
          },
        },
      },
    },
  }, async (request) => {
    const { q } = request.query
    if (!q) return []
    const results = await knowledgeService.searchRelevant(request.workspaceId, q)
    return results.map(({ item, score }) => ({ ...item, similarity_score: score }))
  })

  // ─── POST /api/:workspaceId/knowledge ─────────────────────────────────────
  fastify.post('/', {
    preHandler: adminHandler,
    schema: {
      tags: ['Knowledge'],
      summary: 'Crear ítem de conocimiento',
      description: 'Agrega un nuevo ítem a la base de conocimiento. El sistema genera automáticamente el **embedding** para búsqueda semántica. **Requiere rol admin.**',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['title', 'content'],
        properties: {
          type: {
            type: 'string',
            enum: ['faq', 'document', 'flow', 'snippet', 'protocol'],
            default: 'faq',
            description: '`faq` = pregunta/respuesta, `document` = documento largo, `flow` = flujo conversacional, `snippet` = fragmento reutilizable, `protocol` = protocolo con pasos guiados',
          },
          title:                { type: 'string', example: '¿Cuáles son sus horarios?' },
          content:              { type: 'string', example: 'Atendemos de lunes a viernes de 8:00 a 18:00 hs.' },
          confidence_threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.75, example: 0.8 },
          tags:                 { type: 'array', items: { type: 'string' }, example: ['horarios', 'atencion'] },
          protocol_steps: {
            type: 'array',
            items: {
              type: 'object',
              required: ['step_number', 'title', 'instructions'],
              properties: {
                step_number:       { type: 'integer' },
                title:             { type: 'string' },
                instructions:      { type: 'string' },
                completion_signal: { type: 'string', nullable: true },
                requires_data:     { type: 'string', nullable: true, enum: ['name', 'email', 'phone', 'identification'] },
                max_turns_in_step: { type: 'integer', default: 5 },
              },
            },
          },
        },
      },
      response: {
        201: { description: 'Ítem creado', ...KnowledgeItemObject },
        403: { description: 'Se requiere rol admin', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    await fastify.checkLimit(request.workspaceId, 'knowledge_item')

    // Validación de negocio: los protocolos deben tener al menos un paso
    if (request.body.type === 'protocol') {
      const steps = request.body.protocol_steps
      if (!steps || steps.length === 0) {
        return reply.code(400).send({ error: 'Un protocolo debe tener al menos un paso' })
      }
    }

    if (request.body.type === 'protocol' && request.body.protocol_steps?.length > 0) {
      const sorted = [...request.body.protocol_steps].sort((a, b) => a.step_number - b.step_number)
      const isConsecutive = sorted.every((step, i) => step.step_number === i + 1)
      if (!isConsecutive) {
        return reply.code(400).send({ error: 'Los pasos del protocolo deben numerarse consecutivamente comenzando en 1 (1, 2, 3...)' })
      }
    }

    const item = await knowledgeService.createItem(request.workspaceId, request.body)
    return reply.code(201).send(item)
  })

  // ─── POST /api/:workspaceId/knowledge/upload ──────────────────────────────
  fastify.post('/upload', {
    preHandler: adminHandler,
    schema: {
      tags: ['Knowledge'],
      summary: 'Subir archivo para base de conocimiento',
      description: 'Sube un archivo TXT, MD, PDF o DOCX y lo convierte en un ítem de conocimiento.',
      security,
      consumes: ['multipart/form-data'],
      params: workspaceParam,
      response: {
        201: { ...KnowledgeItemObject },
        400: { ...errorResponse },
        403: { ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const parts = request.parts()
    let fileBuffer = null
    let fileName = ''
    let mimeType = ''
    let title = ''
    let tags = []

    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer()
        fileName = part.filename
        mimeType = part.mimetype
      } else if (part.fieldname === 'title') {
        title = part.value
      } else if (part.fieldname === 'tags') {
        try { tags = JSON.parse(part.value) } catch { tags = [] }
      }
    }

    if (!fileBuffer) return reply.code(400).send({ error: 'No se recibió archivo' })

    let content = ''
    const ext = fileName.split('.').pop()?.toLowerCase()

    let itemType = 'document'
    try {
      if (ext === 'txt' || ext === 'md') {
        content = fileBuffer.toString('utf-8')
      } else if (ext === 'pdf') {
        const pdfParse = require('pdf-parse')
        const data = await pdfParse(fileBuffer)
        content = data.text
      } else if (ext === 'docx') {
        const mammoth = require('mammoth')
        const result = await mammoth.extractRawText({ buffer: fileBuffer })
        content = result.value
      } else if (ext === 'xlsx' || ext === 'xls') {
        content  = parseExcelToText(fileBuffer, fileName)
        itemType = 'spreadsheet'
      } else {
        return reply.code(400).send({ error: 'Formato no soportado. Usa TXT, MD, PDF, DOCX, XLSX o XLS.' })
      }
    } catch (err) {
      request.log.error({ err }, 'Error parseando archivo')
      return reply.code(400).send({ error: 'No se pudo leer el archivo' })
    }

    const itemTitle = title || fileName.replace(/\.[^.]+$/, '')
    const item = await knowledgeService.createItem(request.workspaceId, {
      type: itemType,
      title: itemTitle,
      content: content.trim(),
      tags,
    })
    return reply.code(201).send(item)
  })

  // ─── POST /api/:workspaceId/knowledge/:itemId/reindex ────────────────────
  fastify.post('/:itemId/reindex', {
    preHandler: adminHandler,
    schema: {
      tags: ['Knowledge'],
      summary: 'Re-indexar ítem en Qdrant',
      description: 'Fuerza la re-generación de embeddings y la indexación en Qdrant para un ítem específico.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'itemId'],
        properties: {
          workspaceId: { type: 'string' },
          itemId:      { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            chunks:  { type: 'integer' },
            skipped: { type: 'integer' },
            ok:      { type: 'boolean' },
          },
        },
        404: { ...errorResponse },
        503: { ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { itemId } = request.params

    if (!process.env.OLLAMA_URL) {
      return reply.code(503).send({ error: 'OLLAMA_URL no configurado. Se necesita Ollama para generar embeddings.' })
    }

    const ragService = require('../../services/rag.service')
    const KnowledgeItem = require('../../db/models/knowledge-item')

    const item = await KnowledgeItem.findOne({
      _id: itemId, workspace_id: request.workspaceId,
    }).lean()
    if (!item) return reply.code(404).send({ error: 'Ítem no encontrado' })

    // Borrar vectores viejos y re-indexar
    await ragService.deleteItemVectors(request.workspaceId, itemId)
    const result = await ragService.indexItem(
      request.workspaceId, itemId, item.content, item.title
    )

    return { ...result, ok: result.chunks > 0 }
  })

  // ─── GET /api/:workspaceId/knowledge/debug-search ────────────────────────
  // Traza el pipeline RAG completo paso a paso. Solo para depuración.
  fastify.get('/debug-search', {
    preHandler: adminHandler,
    schema: {
      tags: ['Knowledge'],
      summary: 'Debug RAG pipeline completo',
      params: workspaceParam,
      querystring: {
        type: 'object',
        required: ['q'],
        properties: {
          q:        { type: 'string' },
          item_id:  { type: 'string', description: 'Filtrar por un item_id específico (opcional)' },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (request) => {
    const { q, item_id } = request.query
    const { generateEmbedding } = require('../../services/llm/ollama.adapter')
    const qdrant = require('../../services/qdrant.service')

    const debug = {
      query:            q,
      ollama_url:       process.env.OLLAMA_URL || null,
      qdrant_url:       process.env.QDRANT_URL || null,
      embed_model:      process.env.OLLAMA_EMBED_MODEL || 'llama3.2:1b',
      step1_embedding:  null,
      step2_qdrant_raw: null,    // sin filtro de item
      step3_qdrant_filtered: null, // con filtro de item (si se pasó item_id)
      step4_knowledge_search: null,
      error: null,
    }

    // PASO 1 – Generar embedding de la consulta
    try {
      const vec = await generateEmbedding(q, debug.embed_model)
      debug.step1_embedding = {
        ok:         vec.length > 0,
        dimensions: vec.length,
        preview:    vec.slice(0, 5),
      }

      if (vec.length > 0) {
        // PASO 2 – Buscar en Qdrant sin filtro
        const rawResults = await qdrant.searchChunks(request.workspaceId, vec, {
          topK: 5,
          scoreThreshold: 0.0,
        })
        debug.step2_qdrant_raw = rawResults.map(r => ({
          score:             r.score,
          knowledge_item_id: r.payload?.knowledge_item_id,
          text_preview:      r.payload?.text?.slice(0, 300),
          text_length:       r.payload?.text?.length,
        }))

        // PASO 3 – Buscar en Qdrant con filtro de item_id (si se pasó)
        if (item_id) {
          const filteredResults = await qdrant.searchChunks(request.workspaceId, vec, {
            topK: 5,
            scoreThreshold: 0.0,
            filterItemIds: [item_id],
          })
          debug.step3_qdrant_filtered = filteredResults.map(r => ({
            score:             r.score,
            knowledge_item_id: r.payload?.knowledge_item_id,
            text_preview:      r.payload?.text?.slice(0, 300),
            text_length:       r.payload?.text?.length,
          }))
        }
      }
    } catch (err) {
      debug.error = err.message
    }

    // PASO 4 – searchRelevant completo (como lo llama el bot)
    try {
      const knowledgeService = require('../../services/knowledge.service')
      const filterIds = item_id ? [item_id] : null
      const results = await knowledgeService.searchRelevant(request.workspaceId, q, { filterIds })
      debug.step4_knowledge_search = results.map(r => ({
        score:        r.score,
        item_id:      r.item._id,
        title:        r.item.title,
        content_prev: r.item.content?.slice(0, 120),
      }))
    } catch (err) {
      debug.step4_error = err.message
    }

    return debug
  })

  // ─── GET /api/:workspaceId/knowledge/diagnose ─────────────────────────────
  fastify.get('/diagnose', {
    preHandler: adminHandler,
    schema: {
      tags: ['Knowledge'],
      summary: 'Diagnóstico de Ollama + Qdrant',
      description: 'Verifica la conexión con Ollama y Qdrant y prueba la generación de embeddings.',
      security,
      params: workspaceParam,
      response: {
        200: {
          type: 'object',
          properties: {
            ollama_reachable:    { type: 'boolean' },
            qdrant_reachable:    { type: 'boolean' },
            embed_model:         { type: 'string' },
            embed_works:         { type: 'boolean' },
            embed_dimensions:    { type: 'integer' },
            ollama_url:          { type: 'string' },
            qdrant_url:          { type: 'string' },
            error:               { type: 'string', nullable: true },
          },
        },
      },
    },
  }, async (request) => {
    const { generateEmbedding, listOllamaModels } = require('../../services/llm/ollama.adapter')
    const { ping } = require('../../services/qdrant.service')
    const AIProvider = require('../../db/models/ai-provider')

    const config     = await AIProvider.findOne({ workspace_id: request.workspaceId }).lean()
    const embedModel = process.env.OLLAMA_EMBED_MODEL || config?.embed_model || 'nomic-embed-text'

    const result = {
      ollama_url:       process.env.OLLAMA_URL || 'no configurado',
      qdrant_url:       process.env.QDRANT_URL || 'no configurado',
      embed_model:      embedModel,
      ollama_reachable: false,
      qdrant_reachable: false,
      embed_works:      false,
      embed_dimensions: 0,
      error:            null,
    }

    // Comprobar Qdrant
    result.qdrant_reachable = await ping().catch(() => false)

    // Comprobar Ollama (listando modelos)
    const models = await listOllamaModels().catch(() => [])
    result.ollama_reachable = models.length > 0

    // Probar embedding real
    if (result.ollama_reachable) {
      try {
        const vec = await generateEmbedding('prueba de embedding', embedModel)
        result.embed_works      = vec.length > 0
        result.embed_dimensions = vec.length
        if (!result.embed_works) {
          result.error = `El modelo "${embedModel}" no generó embedding. ¿Está descargado en Ollama?`
        }
      } catch (err) {
        result.error = err.message
      }
    } else {
      result.error = `No se puede conectar a Ollama en ${result.ollama_url}`
    }

    return result
  })

  // ─── POST /api/:workspaceId/knowledge/:itemId/replace ────────────────────
  fastify.post('/:itemId/replace', {
    preHandler: adminHandler,
    schema: {
      tags: ['Knowledge'],
      summary: 'Reemplazar archivo de un ítem de conocimiento',
      description: 'Sube un nuevo archivo (PDF, DOCX, TXT, MD) y reemplaza el contenido del ítem existente. Los vectores de Qdrant se actualizan automáticamente.',
      security,
      consumes: ['multipart/form-data'],
      params: {
        type: 'object',
        required: ['workspaceId', 'itemId'],
        properties: {
          workspaceId: { type: 'string' },
          itemId:      { type: 'string' },
        },
      },
      response: {
        200: { ...KnowledgeItemObject },
        400: { ...errorResponse },
        403: { ...errorResponse },
        404: { ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { itemId } = request.params

    const parts = request.parts()
    let fileBuffer = null
    let fileName   = ''

    for await (const part of parts) {
      if (part.type === 'file') {
        fileBuffer = await part.toBuffer()
        fileName   = part.filename
      }
    }

    if (!fileBuffer) return reply.code(400).send({ error: 'No se recibió archivo' })

    const ext = fileName.split('.').pop()?.toLowerCase()
    let content = ''

    const replaceUpdates = {}
    try {
      if (ext === 'txt' || ext === 'md') {
        replaceUpdates.content = fileBuffer.toString('utf-8').trim()
      } else if (ext === 'pdf') {
        const pdfParse = require('pdf-parse')
        const data = await pdfParse(fileBuffer)
        replaceUpdates.content = data.text.trim()
      } else if (ext === 'docx') {
        const mammoth = require('mammoth')
        const result = await mammoth.extractRawText({ buffer: fileBuffer })
        replaceUpdates.content = result.value.trim()
        replaceUpdates.type = 'document'
      } else if (ext === 'xlsx' || ext === 'xls') {
        replaceUpdates.content = parseExcelToText(fileBuffer, fileName).trim()
        replaceUpdates.type = 'spreadsheet'
      } else {
        return reply.code(400).send({ error: 'Formato no soportado. Usa TXT, MD, PDF, DOCX, XLSX o XLS.' })
      }
    } catch (err) {
      request.log.error({ err }, 'Error parseando archivo en replace')
      return reply.code(400).send({ error: 'No se pudo leer el archivo' })
    }

    // Actualizar item (re-indexa en Qdrant automáticamente dentro del service)
    const item = await knowledgeService.updateItem(request.workspaceId, itemId, replaceUpdates)

    return item
  })

  // ─── PATCH /api/:workspaceId/knowledge/:itemId ────────────────────────────
  fastify.patch('/:itemId', {
    preHandler: adminHandler,
    schema: {
      tags: ['Knowledge'],
      summary: 'Actualizar ítem de conocimiento',
      description: 'Modifica el contenido o configuración de un ítem. Si se cambia `content`, el embedding se regenera automáticamente. **Requiere rol admin.**',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'itemId'],
        properties: {
          workspaceId: { type: 'string' },
          itemId:      { type: 'string', description: 'ID del ítem' },
        },
      },
      body: {
        type: 'object',
        properties: {
          title:                { type: 'string' },
          content:              { type: 'string' },
          confidence_threshold: { type: 'number', minimum: 0, maximum: 1 },
          active:               { type: 'boolean' },
          tags:                 { type: 'array', items: { type: 'string' } },
        },
      },
      response: {
        200: { description: 'Ítem actualizado', ...KnowledgeItemObject },
        403: { description: 'Se requiere rol admin', ...errorResponse },
        404: { description: 'Ítem no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    return knowledgeService.updateItem(request.workspaceId, request.params.itemId, request.body)
  })

  // ─── DELETE /api/:workspaceId/knowledge/:itemId ───────────────────────────
  fastify.delete('/:itemId', {
    preHandler: adminHandler,
    schema: {
      tags: ['Knowledge'],
      summary: 'Eliminar ítem de conocimiento',
      description: '**Requiere rol admin.** Esta acción es irreversible.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'itemId'],
        properties: {
          workspaceId: { type: 'string' },
          itemId:      { type: 'string' },
        },
      },
      response: {
        204: { type: 'null', description: 'Ítem eliminado (sin contenido)' },
        403: { description: 'Se requiere rol admin', ...errorResponse },
        404: { description: 'Ítem no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    await knowledgeService.deleteItem(request.workspaceId, request.params.itemId)
    return reply.code(204).send()
  })
}

module.exports = knowledgeRoutes
