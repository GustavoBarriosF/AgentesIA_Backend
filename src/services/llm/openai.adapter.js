'use strict'

/**
 * openai.adapter.js
 *
 * Adaptador para OpenAI (GPT).
 * Usa la API REST directamente (sin SDK) para evitar dependencias adicionales.
 *
 * Requiere API key por workspace (no hay clave global del servidor).
 */

const axios  = require('axios')
const logger = require('../../utils/logger')

const OPENAI_BASE = 'https://api.openai.com/v1'

const OPENAI_MODELS = [
  { id: 'gpt-4o',        name: 'GPT-4o',        description: 'El más potente, multimodal' },
  { id: 'gpt-4o-mini',   name: 'GPT-4o Mini',   description: 'Rápido y muy eficiente' },
  { id: 'gpt-4-turbo',   name: 'GPT-4 Turbo',   description: 'Alta calidad, contexto largo' },
  { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', description: 'Económico y rápido' },
]

/**
 * @param {{ messages: Array, systemPrompt?: string, model?: string, apiKey: string }} opts
 * @returns {{ content: string, input_tokens: number, output_tokens: number }}
 */
async function callOpenAI({ messages, systemPrompt, model, apiKey }) {
  if (!apiKey) {
    throw Object.assign(
      new Error('OpenAI API key no configurada para este workspace'),
      { statusCode: 503 }
    )
  }

  const resolvedModel = model || 'gpt-4o-mini'

  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages

  try {
    const res = await axios.post(
      `${OPENAI_BASE}/chat/completions`,
      {
        model:      resolvedModel,
        messages:   msgs,
        max_tokens: 1024,
      },
      {
        headers: {
          Authorization:  `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60_000,
      }
    )

    const choice = res.data.choices?.[0]
    return {
      content:       choice?.message?.content || '',
      input_tokens:  res.data.usage?.prompt_tokens     || 0,
      output_tokens: res.data.usage?.completion_tokens || 0,
    }
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message
    logger.error({ err: msg, model: resolvedModel }, '[OpenAI] Error en chat')
    throw Object.assign(new Error(`OpenAI error: ${msg}`), { statusCode: 503 })
  }
}

module.exports = { callOpenAI, OPENAI_MODELS }
