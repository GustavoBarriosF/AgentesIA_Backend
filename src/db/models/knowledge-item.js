'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const protocolStepSchema = new Schema({
  step_number:        { type: Number, required: true },
  title:              { type: String, required: true, trim: true },
  instructions:       { type: String, required: true },
  completion_signal:  { type: String, default: null },   // señal que el LLM emite al completar este paso. Si es null, el paso avanza automáticamente.
  requires_data:      { type: String, enum: ['name', 'email', 'phone', 'identification', null], default: null },
  max_turns_in_step:  { type: Number, default: 5 },
}, { _id: false })

const knowledgeItemSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  type: { type: String, enum: ['faq', 'document', 'flow', 'snippet', 'spreadsheet', 'protocol'], default: 'faq' },
  title: { type: String, required: true, trim: true },
  content: { type: String, required: true },
  embedding: { type: [Number], default: [] },
  confidence_threshold: { type: Number, default: 0.75, min: 0, max: 1 },
  active: { type: Boolean, default: true },
  tags: [{ type: String, trim: true }],
  usage_count: { type: Number, default: 0 },
  helpful_count: { type: Number, default: 0 },
  unhelpful_count: { type: Number, default: 0 },
  // ── RAG (Qdrant) ──────────────────────────────────────────────────────────
  rag_indexed:    { type: Boolean, default: false },   // true cuando está indexado en Qdrant
  rag_chunks:     { type: Number,  default: 0 },       // cantidad de chunks en Qdrant
  rag_indexed_at: { type: Date,    default: null },    // última vez que se indexó
  protocol_steps: { type: [protocolStepSchema], default: [] },
}, { timestamps: true })

knowledgeItemSchema.index({ workspace_id: 1, active: 1, type: 1 })
knowledgeItemSchema.index({ workspace_id: 1, tags: 1 })

module.exports = mongoose.model('KnowledgeItem', knowledgeItemSchema)
