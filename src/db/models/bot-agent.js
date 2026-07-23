'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

/**
 * BotAgent unifica dos conceptos:
 *   type = 'decision_bot'  → árbol de decisiones con opciones y routing
 *   type = 'ai_agent'      → agente LLM (Claude) con base de conocimiento propia
 */

const actionSchema = new Schema({
  type: {
    type: String,
    enum: [
      'next_step', 'goto_step', 'route_bot', 'route_agent', 'escalate_human', 'end',
      'collect_name', 'collect_email', 'collect_phone',
      // ── Acciones ERP ──────────────────────────────────────────────────────
      'collect_identification', // recolecta cédula/NIT y autentica en el ERP
      'query_erp_balance',      // muestra estado de cuenta del cliente
      'query_erp_invoices',     // lista facturas pendientes del cliente
      'create_erp_invoice',     // crea factura en el ERP (post-venta)
      'register_erp_payment',   // registra un pago en el ERP
      'create_ticket',          // resume la conversación con IA y crea un ticket
      'collect_text',           // espera cualquier respuesta de texto libre del cliente
      'send_payment_link',      // genera y envía un link de pago al cliente
    ],
    required: true,
  },
  // Para goto_step: índice del step destino
  goto_step_index: { type: Number, default: null },
  // Para route_bot: ID del BotAgent destino (decision_bot)
  target_bot_id: { type: Schema.Types.ObjectId, ref: 'BotAgent', default: null },
  // Para route_agent: ID del BotAgent destino (ai_agent)
  target_agent_id: { type: Schema.Types.ObjectId, ref: 'BotAgent', default: null },
  // Para end: mensaje de cierre opcional
  end_message: { type: String, default: null },
  // Para collect_*: mensaje que el bot envía para solicitar el dato
  collect_message: { type: String, default: null },
  // Para collect_email / collect_phone / collect_identification: mensaje cuando inválido
  collect_error_message: { type: String, default: null },
  // Para collect_text: clave con la que se guarda la respuesta en bot_collected_data
  collect_key: { type: String, default: null },
  // Para create_erp_invoice / register_erp_payment: configuración adicional
  erp_action_config: { type: Schema.Types.Mixed, default: null },
  // Para create_ticket: configuración del ticket generado por IA
  ticket_config: { type: Schema.Types.Mixed, default: null },
  // Para escalate_human: asignar directamente a un miembro o departamento
  assigned_member_id:     { type: Schema.Types.ObjectId, ref: 'User',       default: null },
  assigned_department_id: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
  // Para send_payment_link
  payment_link_id: { type: Schema.Types.ObjectId, ref: 'PaymentLink', default: null },
  product_id:      { type: Schema.Types.ObjectId, ref: 'Product',     default: null },
  success_message: { type: String, default: null }, // mensaje junto al link (si null, usa default)
}, { _id: false })

const optionSchema = new Schema({
  label: { type: String, required: true, trim: true }, // texto del botón / opción
  action: { type: actionSchema, required: true },
}, { _id: false })

const stepSchema = new Schema({
  message: { type: String, required: true },  // lo que el bot dice
  options: { type: [optionSchema], default: [] }, // opciones de respuesta rápida
  // Acción automática: se ejecuta si no hay opciones (sin esperar input del usuario)
  action: { type: actionSchema, default: null },
})

const botAgentSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  name:         { type: String, required: true, trim: true },
  avatar:       { type: String, default: null }, // base64 data URL
  type: {
    type: String,
    enum: ['decision_bot', 'ai_agent'],
    required: true,
  },
  active: { type: Boolean, default: true },

  // ── Decision Bot ──────────────────────────────────────────────────────────
  steps: { type: [stepSchema], default: [] },

  // ── AI Agent ──────────────────────────────────────────────────────────────
  system_prompt:    { type: String, default: '' },
  knowledge_item_ids: [{ type: Schema.Types.ObjectId, ref: 'KnowledgeItem' }],
  // provider: si es null/undefined se hereda del AIProvider del workspace
  provider: {
    type: String,
    enum: ['claude', 'ollama', null],
    default: null,
  },
  // model: cualquier string válido para el proveedor elegido
  // Claude:  claude-haiku-4-5-20251001 | claude-sonnet-4-6 | claude-opus-4-6
  // Ollama:  llama3.2:1b | deepseek-r1:7b | mistral:7b | etc.
  model: {
    type: String,
    default: null, // null = hereda del AIProvider del workspace
  },
  max_turns:                  { type: Number, default: 8 },
  rag_top_k:                  { type: Number, default: 12 },
  escalate_on_low_confidence: { type: Boolean, default: true },
  default_department_id: { type: Schema.Types.ObjectId, ref: 'Department', default: null },

  // Recopilación de datos del contacto — desactivada por defecto
  collect_name:           { type: Boolean, default: false },
  collect_phone:          { type: Boolean, default: false },
  collect_email:          { type: Boolean, default: false },
  collect_identification: { type: Boolean, default: false },

  // Protocolo estructurado opcional — si está definido, el ai_agent sigue los pasos en orden
  // en vez de usar RAG libre. Referencia a un KnowledgeItem de tipo 'protocol'.
  protocol_id: { type: Schema.Types.ObjectId, ref: 'KnowledgeItem', default: null },

}, { timestamps: true })

botAgentSchema.index({ workspace_id: 1, type: 1 })
botAgentSchema.index({ workspace_id: 1, active: 1 })

module.exports = mongoose.model('BotAgent', botAgentSchema)
