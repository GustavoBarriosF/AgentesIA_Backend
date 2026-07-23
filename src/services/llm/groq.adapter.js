'use strict'

/**
 * groq.adapter.js
 *
 * Adaptador para Groq Cloud (inferencia ultrarrápida).
 * Groq usa la misma API REST que OpenAI (compatible), solo cambia la base URL y los modelos.
 *
 * Requiere API key por workspace (obtener en https://console.groq.com/keys).
 *
 * Modelos de chat disponibles (abril 2026):
 *   llama-3.3-70b-versatile             → LLaMA 3.3 70B, alta calidad
 *   llama-3.1-8b-instant                → LLaMA 3.1 8B, ultra rápido
 *   meta-llama/llama-4-scout-17b-16e    → LLaMA 4 Scout, contexto largo
 *   qwen/qwen3-32b                      → Alibaba Qwen 3 32B
 *   openai/gpt-oss-120b                 → OpenAI open model 120B
 *   openai/gpt-oss-20b                  → OpenAI open model 20B
 *   groq/compound / groq/compound-mini  → modelos compuestos de Groq
 *
 * Excluidos (no compatibles con /chat/completions):
 *   whisper-large-v3*          → solo transcripción de audio
 *   canopylabs/orpheus-*       → solo síntesis de voz (TTS)
 *   llama-prompt-guard-*       → clasificador de seguridad, no chat
 *   openai/gpt-oss-safeguard-* → modelo de guardia, no chat general
 */

const axios  = require('axios')
const logger = require('../../utils/logger')

const GROQ_BASE = 'https://api.groq.com/openai/v1'

const GROQ_MODELS = [
  // ── Meta LLaMA ──────────────────────────────────────────────────────────────
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'LLaMA 4 Scout 17B',       description: 'Nuevo · rápido, contexto largo' },
  { id: 'llama-3.3-70b-versatile',                   name: 'LLaMA 3.3 70B Versatile', description: 'Alta calidad, muy recomendado' },
  { id: 'llama-3.1-8b-instant',                      name: 'LLaMA 3.1 8B Instant',    description: 'Ultra rápido, ideal para chat' },
  // ── Alibaba Qwen ────────────────────────────────────────────────────────────
  { id: 'qwen/qwen3-32b',                            name: 'Qwen 3 32B',               description: 'Alibaba Qwen 3, alta capacidad' },
  // ── OpenAI open models via Groq ─────────────────────────────────────────────
  { id: 'openai/gpt-oss-120b',                       name: 'GPT OSS 120B (Groq)',      description: 'OpenAI open model 120B · alta calidad' },
  { id: 'openai/gpt-oss-20b',                        name: 'GPT OSS 20B (Groq)',       description: 'OpenAI open model 20B · rápido' },
  // ── Groq Compound ───────────────────────────────────────────────────────────
  { id: 'groq/compound',                             name: 'Groq Compound',            description: 'Modelo compuesto de Groq' },
  { id: 'groq/compound-mini',                        name: 'Groq Compound Mini',       description: 'Compound ligero y rápido' },
]

/**
 * @param {{ messages: Array, systemPrompt?: string, model?: string, apiKey: string }} opts
 * @returns {{ content: string, input_tokens: number, output_tokens: number }}
 */
async function callGroq({ messages, systemPrompt, model, apiKey }) {
  if (!apiKey) {
    throw Object.assign(
      new Error('Groq API key no configurada para este workspace'),
      { statusCode: 503 }
    )
  }

  const resolvedModel = model || 'llama-3.3-70b-versatile'

  const msgs = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages

  const doRequest = () => axios.post(
    `${GROQ_BASE}/chat/completions`,
    { model: resolvedModel, messages: msgs, max_tokens: 1024 },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30_000,
    }
  )

  try {
    let res
    try {
      res = await doRequest()
    } catch (firstErr) {
      // Retry automático si Groq devuelve rate-limit con tiempo de espera
      const errMsg = firstErr.response?.data?.error?.message || ''
      const waitMatch = errMsg.match(/try again in ([\d.]+)s/i)
      if (firstErr.response?.status === 429 && waitMatch) {
        const waitMs = Math.ceil(parseFloat(waitMatch[1]) * 1000) + 500
        logger.warn({ model: resolvedModel, waitMs }, '[Groq] Rate limit — reintentando')
        await new Promise(r => setTimeout(r, waitMs))
        res = await doRequest()
      } else {
        throw firstErr
      }
    }

    const choice = res.data.choices?.[0]
    return {
      content:       choice?.message?.content || '',
      input_tokens:  res.data.usage?.prompt_tokens     || 0,
      output_tokens: res.data.usage?.completion_tokens || 0,
    }
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message
    logger.error({ err: msg, model: resolvedModel }, '[Groq] Error en chat')
    throw Object.assign(new Error(`Groq error: ${msg}`), { statusCode: 503 })
  }
}

module.exports = { callGroq, GROQ_MODELS }
