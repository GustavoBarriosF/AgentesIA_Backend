'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const leadSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  contact_id: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
  conversation_id: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },
  assigned_to: { type: Schema.Types.ObjectId, ref: 'Agent', default: null },
  stage: {
    type: String,
    enum: ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'],
    default: 'new',
  },
  value: { type: Number, default: null },
  currency: { type: String, default: 'USD' },
  lost_reason: { type: String, default: null },
  notes: [
    {
      content: String,
      author_id: { type: Schema.Types.ObjectId, ref: 'User' },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  custom_fields: { type: Schema.Types.Mixed, default: {} },
  tags: [{ type: String, trim: true }],
}, { timestamps: true })

leadSchema.index({ workspace_id: 1, stage: 1, createdAt: -1 })
leadSchema.index({ workspace_id: 1, contact_id: 1 })
leadSchema.index({ workspace_id: 1, assigned_to: 1 })

module.exports = mongoose.model('Lead', leadSchema)
