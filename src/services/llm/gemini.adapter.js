'use strict'

/**
 * gemini.adapter.js
 *
 * Adaptador para Google Gemini.
 * Usa la API REST v1beta directamente (sin SDK) para evitar dependencias adicionales.
 *
 * Requiere API key por workspace (obtenida en https://aistudio.google.com/app/apikey).
 *
 * Formato de mensajes Gemini:
 *   role: 'user' | 'model'  (NO 'assistant' como OpenAI/Claude)
 *   parts: [{ text: string }]
 */

const axios  = require('axios')
const logger = require('../../utils/logger')

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

const GEMINI_MODELS = [
  { id: 'gemini-2.0-flash',        name: 'Gemini 2.0 Flash',        description: 'Muy rápido, alta calidad (recomendado)' },
  { id: 'gemini-2.0-flash-lite',   name: 'Gemini 2.0 Flash Lite',   description: 'Más ligero y económico' },
  { id: 'gemini-1.5-pro',          name: 'Gemini 1.5 Pro',          description: 'Alta calidad, contexto 1M tokens' },
  { id: 'gemini-1.5-flash',        name: 'Gemini 1.5 Flash',        description: 'Rápido y eficiente' },
]

/**
 * @param {{ messages: Array, systemPrompt?: string, model?: string, apiKey: string }} opts
 * @returns {{ content: string, input_tokens: number, output_tokens: number }}
 */
async function callGemini({ messages, systemPrompt, model, apiKey }) {
  if (!apiKey) {
    throw Object.assign(
      new Error('Gemini API key no configurada para este workspace'),
      { statusCode: 503 }
    )
  }

  const resolvedModel = model || 'gemini-2.0-flash'

  // Convertir historial al formato de Gemini
  // OpenAI/Claude usa role 'assistant' → Gemini usa 'model'
  const contents = messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const body = {
    contents,
    ...(systemPrompt
      ? { systemInstruction: { parts: [{ text: systemPrompt }] } }
      : {}),
    generationConfig: {
      maxOutputTokens: 1024,
    },
  }

  try {
    const res = await axios.post(
      `${GEMINI_BASE}/${resolvedModel}:generateContent?key=${apiKey}`,
      body,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60_000,
      }
    )

    const candidate = res.data.candidates?.[0]
    const content   = candidate?.content?.parts?.[0]?.text || ''
    const usage     = res.data.usageMetadata || {}

    return {
      content,
      input_tokens:  usage.promptTokenCount     || 0,
      output_tokens: usage.candidatesTokenCount || 0,
    }
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message
    logger.error({ err: msg, model: resolvedModel }, '[Gemini] Error en chat')
    throw Object.assign(new Error(`Gemini error: ${msg}`), { statusCode: 503 })
  }
}

module.exports = { callGemini, GEMINI_MODELS }
