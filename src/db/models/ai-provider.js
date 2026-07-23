'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

/**
 * AIProvider – configuración del proveedor de IA por workspace.
 *
 * Proveedores soportados:
 *   claude  → Anthropic Claude  (API key requerida por workspace)
 *   openai  → OpenAI GPT        (API key requerida por workspace)
 *   gemini  → Google Gemini     (API key requerida por workspace)
 *   ollama  → Servidor Ollama local/privado (sin API key, solo URL)
 *
 * Cada workspace configura su propio proveedor con su propia API key.
 * La api_key NUNCA se devuelve al cliente en las respuestas — solo se indica
 * si está configurada mediante el campo `api_key_configured` calculado en la ruta.
 */
const aiProviderSchema = new Schema({
  workspace_id: {
    type: Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    unique: true,
  },
  provider: {
    type: String,
    enum: ['claude', 'openai', 'gemini', 'groq', 'ollama'],
    default: 'claude',
  },
  // Modelo seleccionado (varía según provider)
  // Claude:  claude-haiku-4-5-20251001 | claude-sonnet-4-6 | claude-opus-4-6
  // OpenAI:  gpt-4o | gpt-4o-mini | gpt-4-turbo | gpt-3.5-turbo
  // Gemini:  gemini-2.0-flash | gemini-1.5-pro | gemini-1.5-flash
  // Ollama:  llama3.2:1b | deepseek-r1:7b | mistral:7b | etc.
  model: {
    type: String,
    default: 'claude-haiku-4-5-20251001',
  },
  // API key del proveedor (Claude, OpenAI o Gemini).
  // Para Ollama no aplica (dejar null).
  // Para Claude: si es null se usa workspace.integrations.anthropic_api_key como fallback.
  api_key: {
    type: String,
    default: null,
  },
  // URL personalizada del servidor Ollama (solo provider = 'ollama').
  // Si es null se usa OLLAMA_URL del entorno del servidor.
  ollama_url: {
    type: String,
    default: null,
  },
  // Modelo de embedding de Ollama (para RAG/Qdrant)
  embed_model: {
    type: String,
    default: 'nomic-embed-text',
  },
  active: { type: Boolean, default: true },
}, { timestamps: true })

aiProviderSchema.index({ workspace_id: 1 })

module.exports = mongoose.model('AIProvider', aiProviderSchema)
