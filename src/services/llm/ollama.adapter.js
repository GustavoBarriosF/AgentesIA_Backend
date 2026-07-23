'use strict'

/**
 * ollama.adapter.js
 *
 * Adaptador para Ollama (LLM local / self-hosted).
 * API compatible con OpenAI en /api/chat
 * Endpoint de embeddings: /api/embed
 *
 * Variables de entorno:
 *   OLLAMA_URL         URL base del servidor Ollama (default: http://localhost:11434)
 *   OLLAMA_EMBED_MODEL Modelo de embeddings (default: llama3.2:1b)
 */

const axios = require('axios')
const logger = require('../../utils/logger')

function getBaseUrl(ollamaUrl) {
  return (ollamaUrl || process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '')
}

/**
 * Llama al LLM de Ollama (chat).
 * @param {{ messages, systemPrompt?, model?, ollamaUrl? }} opts
 * @returns {{ content: string, input_tokens: number, output_tokens: number }}
 */
async function callOllama({ messages, systemPrompt, model, ollamaUrl }) {
  const url = getBaseUrl(ollamaUrl)
  const resolvedModel = model || 'llama3.2:latest'

  // Ollama /api/chat acepta role: 'system'
  const payload = {
    model: resolvedModel,
    stream: false,
    options: {
      num_ctx: 32768, // llama3.2 supports 128K; default Ollama context is too small for knowledge base
    },
    messages: systemPrompt
      ? [{ role: 'system', content: systemPrompt }, ...messages]
      : messages,
  }

  try {
    const res = await axios.post(`${url}/api/chat`, payload, {
      timeout: 300_000, // 5 minutos — CPU sin GPU puede tardar en modelos 3-7B
    })

    const data = res.data
    return {
      content:       data.message?.content || '',
      input_tokens:  data.prompt_eval_count || 0,
      output_tokens: data.eval_count        || 0,
    }
  } catch (err) {
    const msg = err.response?.data?.error || err.message
    logger.error({ err: msg, model: resolvedModel }, '[Ollama] Error en chat')
    throw Object.assign(new Error(`Ollama error: ${msg}`), { statusCode: 503 })
  }
}

/**
 * Genera embedding para un texto usando Ollama (/api/embed).
 * @param {string} text
 * @param {string} [model]  - Modelo de embeddings (ej. llama3.2:1b)
 * @param {string} [ollamaUrl]
 * @returns {Promise<number[]>}
 */
async function generateEmbedding(text, model, ollamaUrl) {
  const url = getBaseUrl(ollamaUrl)
  const embedModel = model || process.env.OLLAMA_EMBED_MODEL || 'llama3.2:1b'

  try {
    // /api/embed es la API nueva (Ollama >= 0.1.26)
    const res = await axios.post(`${url}/api/embed`, {
      model: embedModel,
      input: text,
    }, { timeout: 5_000 })

    // Respuesta: { embeddings: [[...]] }
    const embeddings = res.data?.embeddings
    if (Array.isArray(embeddings) && embeddings.length > 0) {
      return embeddings[0]
    }

    // Fallback: /api/embeddings (API antigua)
    const res2 = await axios.post(`${url}/api/embeddings`, {
      model: embedModel,
      prompt: text,
    }, { timeout: 5_000 })
    return res2.data?.embedding || []

  } catch (err) {
    const msg = err.response?.data?.error || err.message
    logger.error({ err: msg, model: embedModel }, '[Ollama] Error generando embedding')
    return []
  }
}

/**
 * Lista los modelos disponibles en el servidor Ollama.
 * @param {string} [ollamaUrl]
 * @returns {Promise<Array<{ name: string, size: number, modified_at: string }>>}
 */
async function listOllamaModels(ollamaUrl) {
  const url = getBaseUrl(ollamaUrl)
  try {
    const res = await axios.get(`${url}/api/tags`, { timeout: 10_000 })
    return (res.data?.models || []).map(m => ({
      name:        m.name,
      size:        m.size,
      modified_at: m.modified_at,
    }))
  } catch (err) {
    logger.error({ err: err.message }, '[Ollama] Error listando modelos')
    return []
  }
}

module.exports = { callOllama, generateEmbedding, listOllamaModels }
