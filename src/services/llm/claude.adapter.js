'use strict'

/**
 * claude.adapter.js
 *
 * Adaptador para Claude (Anthropic).
 * Expone callClaude({ messages, systemPrompt, model, apiKey }) → { content, input_tokens, output_tokens }
 */

const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk')

const CLAUDE_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
]

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

/**
 * @param {{ messages: Array, systemPrompt?: string, model?: string, apiKey?: string }} opts
 * @returns {{ content: string, input_tokens: number, output_tokens: number }}
 */
async function callClaude({ messages, systemPrompt, model, apiKey }) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY
  if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY no configurada'), { statusCode: 503 })

  const anthropic = new Anthropic({ apiKey: key })

  const response = await anthropic.messages.create({
    model: model || DEFAULT_MODEL,
    max_tokens: 1024,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages,
  })

  return {
    content:       response.content[0]?.text || '',
    input_tokens:  response.usage?.input_tokens  || 0,
    output_tokens: response.usage?.output_tokens || 0,
  }
}

module.exports = { callClaude, CLAUDE_MODELS, DEFAULT_MODEL }
