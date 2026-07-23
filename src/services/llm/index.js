'use strict'

/**
 * llm/index.js  –  Fábrica de proveedores de IA
 *
 * Uso:
 *   const { callLLM } = require('./llm')
 *   const result = await callLLM(messages, { workspaceId, systemPrompt })
 *   // → { content, input_tokens, output_tokens, provider, model }
 *
 * La función resuelve qué proveedor/modelo usar en este orden:
 *   1. Si se pasan `provider` y `model` explícitos → usar esos
 *   2. Si se pasa `workspaceId` → buscar AIProvider del workspace
 *   3. Fallback → Claude con clave global ANTHROPIC_API_KEY
 *
 * Proveedores soportados:
 *   claude  → Anthropic (api_key del workspace > anthropic_api_key del workspace > env)
 *   openai  → OpenAI GPT (api_key del workspace, obligatoria)
 *   gemini  → Google Gemini (api_key del workspace, obligatoria)
 *   ollama  → Ollama local (ollama_url del workspace > OLLAMA_URL del env)
 */

const { callClaude }  = require('./claude.adapter')
const { callOllama }  = require('./ollama.adapter')
const { callOpenAI }  = require('./openai.adapter')
const { callGemini }  = require('./gemini.adapter')
const { callGroq }    = require('./groq.adapter')
const AIProvider      = require('../../db/models/ai-provider')
const Workspace       = require('../../db/models/workspace')
const logger          = require('../../utils/logger')

/**
 * @param {Array<{ role: string, content: string }>} messages
 * @param {{
 *   workspaceId?:  string,
 *   systemPrompt?: string,
 *   provider?:     'claude' | 'openai' | 'gemini' | 'ollama',
 *   model?:        string,
 *   workspace?:    object,   // objeto workspace ya cargado (evita re-fetch)
 * }} opts
 * @returns {Promise<{ content: string, input_tokens: number, output_tokens: number, provider: string, model: string }>}
 */
async function callLLM(messages, opts = {}) {
  const { workspaceId, systemPrompt, workspace: preloadedWs } = opts
  let { provider, model } = opts

  // ── 1. Resolver configuración del workspace ──────────────────────────────
  let ollamaUrl  = null
  let apiKey     = null   // API key del workspace (Claude, OpenAI o Gemini)
  let claudeLegacyKey = null  // Fallback: workspace.integrations.anthropic_api_key

  if (workspaceId) {
    // Siempre cargamos la config del workspace para obtener la API key,
    // aunque el bot ya tenga provider/model explícitos.
    const [providerConfig, ws] = await Promise.all([
      AIProvider.findOne({ workspace_id: workspaceId }).lean(),
      preloadedWs ? Promise.resolve(preloadedWs) : Workspace.findById(workspaceId).select('integrations').lean(),
    ])

    if (providerConfig) {
      provider   = provider || providerConfig.provider   // bot override > workspace default
      model      = model    || providerConfig.model       // bot override > workspace default
      apiKey     = providerConfig.api_key     || null     // siempre desde workspace
      ollamaUrl  = providerConfig.ollama_url  || null
    }

    // Mantener compatibilidad con clave Anthropic guardada en workspace (campo heredado)
    claudeLegacyKey = ws?.integrations?.anthropic_api_key || null
  }

  // ── 2. Defaults finales ──────────────────────────────────────────────────
  provider = provider || 'claude'
  model    = model    || defaultModel(provider)

  // ── 3. Llamar al adaptador correspondiente ───────────────────────────────
  let result

  switch (provider) {

    case 'ollama':
      result = await callOllama({ messages, systemPrompt, model, ollamaUrl })
      break

    case 'openai':
      result = await callOpenAI({
        messages,
        systemPrompt,
        model,
        apiKey,
      })
      break

    case 'gemini':
      result = await callGemini({
        messages,
        systemPrompt,
        model,
        apiKey,
      })
      break

    case 'groq':
      result = await callGroq({
        messages,
        systemPrompt,
        model,
        apiKey,
      })
      break

    case 'claude':
    default:
      // Prioridad: api_key del AIProvider → anthropic_api_key del workspace → variable de entorno
      result = await callClaude({
        messages,
        systemPrompt,
        model,
        apiKey: apiKey || claudeLegacyKey || process.env.ANTHROPIC_API_KEY,
      })
      break
  }

  logger.debug({ provider, model, in: result.input_tokens, out: result.output_tokens }, '[LLM] respuesta')

  return { ...result, provider, model }
}

/**
 * Devuelve el modelo por defecto para un proveedor.
 */
function defaultModel(provider) {
  switch (provider) {
    case 'openai':  return 'gpt-4o-mini'
    case 'gemini':  return 'gemini-2.0-flash'
    case 'groq':    return 'llama-3.3-70b-versatile'
    case 'ollama':  return 'llama3.2:latest'
    case 'claude':
    default:        return 'claude-haiku-4-5-20251001'
  }
}

module.exports = { callLLM }
