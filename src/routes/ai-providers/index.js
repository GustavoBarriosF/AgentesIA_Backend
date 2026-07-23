'use strict'

/**
 * ai-providers routes
 *
 * GET    /api/:workspaceId/ai-providers          → configuración actual (sin api_key)
 * PUT    /api/:workspaceId/ai-providers          → crear/actualizar proveedor + api_key
 * GET    /api/:workspaceId/ai-providers/models   → modelos disponibles por proveedor
 * POST   /api/:workspaceId/ai-providers/reindex  → re-indexar toda la base de conocimiento
 */

const AIProvider           = require('../../db/models/ai-provider')
const { listOllamaModels } = require('../../services/llm/ollama.adapter')
const { OPENAI_MODELS }    = require('../../services/llm/openai.adapter')
const { GEMINI_MODELS }    = require('../../services/llm/gemini.adapter')
const { GROQ_MODELS }      = require('../../services/llm/groq.adapter')
const { reindexWorkspace } = require('../../services/rag.service')
const { ping }             = require('../../services/qdrant.service')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

const PROVIDER_ENUM = ['claude', 'openai', 'gemini', 'groq', 'ollama']

// Modelos de Claude disponibles
const CLAUDE_MODELS = [
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku',  provider: 'claude', description: 'Rápido y eficiente' },
  { id: 'claude-sonnet-4-6',         name: 'Claude Sonnet', provider: 'claude', description: 'Balance velocidad/calidad' },
  { id: 'claude-opus-4-6',           name: 'Claude Opus',   provider: 'claude', description: 'Máxima calidad' },
]

/**
 * Convierte un documento AIProvider a objeto de respuesta.
 * NUNCA incluye la api_key real — solo si está configurada (booleano).
 */
function toResponse(config) {
  if (!config) return null
  const { api_key, ...rest } = config
  return {
    ...rest,
    api_key_configured: !!api_key,
  }
}

const AIProviderObject = {
  type: 'object',
  properties: {
    _id:                { type: 'string' },
    workspace_id:       { type: 'string' },
    provider:           { type: 'string', enum: PROVIDER_ENUM },
    model:              { type: 'string' },
    embed_model:        { type: 'string' },
    ollama_url:         { type: 'string', nullable: true },
    api_key_configured: { type: 'boolean', description: 'true si hay una API key guardada para el proveedor actual' },
    active:             { type: 'boolean' },
    createdAt:          { type: 'string', format: 'date-time' },
    updatedAt:          { type: 'string', format: 'date-time' },
  },
}

async function aiProvidersRoutes(fastify) {
  const preHandler   = [fastify.authenticate, fastify.requireWorkspace]
  const adminHandler = [...preHandler, fastify.requireRole('admin')]

  // ─── GET /api/:workspaceId/ai-providers ───────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['AI Providers'],
      summary: 'Obtener configuración del proveedor de IA',
      description: 'Retorna la configuración actual. El campo `api_key_configured` indica si hay una API key guardada (la clave real nunca se devuelve).',
      security,
      params: workspaceParam,
      response: {
        200: AIProviderObject,
        401: errorResponse,
      },
    },
  }, async (request) => {
    const config = await AIProvider.findOne({ workspace_id: request.workspaceId }).lean()

    if (!config) {
      // Defaults para workspace sin config
      return {
        workspace_id:       request.workspaceId,
        provider:           'claude',
        model:              'claude-haiku-4-5-20251001',
        embed_model:        'llama3.2:1b',
        ollama_url:         null,
        api_key_configured: false,
        active:             true,
      }
    }

    return toResponse(config)
  })

  // ─── PUT /api/:workspaceId/ai-providers ───────────────────────────────────
  fastify.put('/', {
    preHandler: adminHandler,
    schema: {
      tags: ['AI Providers'],
      summary: 'Configurar proveedor de IA del workspace',
      description: [
        'Crea o actualiza el proveedor de IA. **Requiere rol admin.**',
        '',
        '### API keys por proveedor:',
        '- **claude** → Obtener en https://console.anthropic.com/settings/keys',
        '- **openai** → Obtener en https://platform.openai.com/api-keys',
        '- **gemini** → Obtener en https://aistudio.google.com/app/apikey',
        '- **ollama** → No requiere API key, solo URL del servidor',
        '',
        'Si se omite `api_key` en el body, se conserva la que ya estaba guardada.',
        'Para borrar la key enviar `api_key: ""`.',
      ].join('\n'),
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['provider', 'model'],
        properties: {
          provider:    { type: 'string', enum: PROVIDER_ENUM, description: 'Proveedor de IA' },
          model:       { type: 'string', description: 'ID del modelo de chat' },
          api_key:     { type: 'string', description: 'API key del proveedor (Claude, OpenAI o Gemini). Omitir para conservar la actual.' },
          ollama_url:  { type: 'string', description: 'URL del servidor Ollama (solo provider=ollama). Null = usar variable de entorno.' },
          embed_model: { type: 'string', description: 'Modelo Ollama para embeddings/RAG. Recomendado: llama3.2:1b' },
        },
      },
      response: {
        200: AIProviderObject,
        400: errorResponse,
        403: errorResponse,
      },
    },
  }, async (request) => {
    const { provider, model, api_key, ollama_url, embed_model } = request.body

    const setData = {
      provider,
      model,
      active: true,
      ...(embed_model !== undefined ? { embed_model } : {}),
      ...(ollama_url  !== undefined ? { ollama_url: ollama_url || null } : {}),
    }

    // Solo actualizar api_key si se envió explícitamente en el body
    if (api_key !== undefined) {
      setData.api_key = api_key || null
    }

    const config = await AIProvider.findOneAndUpdate(
      { workspace_id: request.workspaceId },
      { $set: setData },
      { upsert: true, new: true }
    )

    return toResponse(config.toObject())
  })

  // ─── GET /api/:workspaceId/ai-providers/models ────────────────────────────
  fastify.get('/models', {
    preHandler,
    schema: {
      tags: ['AI Providers'],
      summary: 'Listar modelos disponibles por proveedor',
      description: 'Retorna listas de modelos para Claude, OpenAI, Gemini y Ollama (dinámico).',
      security,
      params: workspaceParam,
      response: {
        200: {
          type: 'object',
          properties: {
            claude:           { type: 'array', items: { type: 'object', additionalProperties: true } },
            openai:           { type: 'array', items: { type: 'object', additionalProperties: true } },
            gemini:           { type: 'array', items: { type: 'object', additionalProperties: true } },
            groq:             { type: 'array', items: { type: 'object', additionalProperties: true } },
            ollama:           { type: 'array', items: { type: 'object', additionalProperties: true } },
            ollama_available: { type: 'boolean' },
            qdrant_available: { type: 'boolean' },
          },
        },
      },
    },
  }, async () => {
    // Consultar Ollama y Qdrant en paralelo
    const [ollamaModels, qdrantOk] = await Promise.all([
      listOllamaModels().catch(() => []),
      ping().catch(() => false),
    ])

    return {
      claude: CLAUDE_MODELS,
      openai: OPENAI_MODELS.map(m => ({ ...m, provider: 'openai' })),
      gemini: GEMINI_MODELS.map(m => ({ ...m, provider: 'gemini' })),
      groq:   GROQ_MODELS.map(m   => ({ ...m, provider: 'groq'   })),
      ollama: ollamaModels.map(m => ({
        id:          m.name,
        name:        m.name,
        provider:    'ollama',
        size:        m.size,
        modified_at: m.modified_at,
      })),
      ollama_available: ollamaModels.length > 0,
      qdrant_available: qdrantOk,
    }
  })

  // ─── POST /api/:workspaceId/ai-providers/reindex ──────────────────────────
  fastify.post('/reindex', {
    preHandler: adminHandler,
    schema: {
      tags: ['AI Providers'],
      summary: 'Re-indexar base de conocimiento en Qdrant',
      description: 'Borra todos los vectores del workspace y re-indexa todos los ítems activos. Útil cuando se cambia el modelo de embeddings.',
      security,
      params: workspaceParam,
      response: {
        200: {
          type: 'object',
          properties: {
            indexed: { type: 'integer' },
            failed:  { type: 'integer' },
            total:   { type: 'integer' },
          },
        },
        503: errorResponse,
      },
    },
  }, async (request, reply) => {
    if (!process.env.OLLAMA_URL) {
      return reply.code(503).send({ error: 'OLLAMA_URL no configurado. Se necesita Ollama para generar embeddings.' })
    }

    // Obtener embed_model: env var tiene prioridad sobre el valor guardado en BD
    const config = await AIProvider.findOne({ workspace_id: request.workspaceId }).lean()
    const embedModel = process.env.OLLAMA_EMBED_MODEL || config?.embed_model || 'nomic-embed-text'

    // Re-indexar en background (puede tardar mucho)
    reindexWorkspace(request.workspaceId, embedModel)
      .catch(err => request.log.error({ err: err.message }, '[AI Providers] Error en re-indexación'))

    return reply.code(200).send({
      indexed: 0,
      failed:  0,
      total:   -1, // procesando en background
      message: 'Re-indexación iniciada en background',
    })
  })
}

module.exports = aiProvidersRoutes
