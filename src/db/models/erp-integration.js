'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const syncLogEntrySchema = new Schema({
  timestamp: { type: Date, default: Date.now },
  action:    { type: String },
  status:    { type: String, enum: ['success', 'error'] },
  detail:    { type: String, default: null },
}, { _id: false })

const erpIntegrationSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  provider: {
    type: String,
    enum: ['siigo', 'alegra', 'quickbooks'],
    required: true,
  },
  credentials: { type: Schema.Types.Mixed, default: {} },
  active:      { type: Boolean, default: true },
  config: {
    field_map:    { type: Schema.Types.Mixed, default: {} },
    currency:     { type: String, default: 'COP' },
    company_name: { type: String, default: null },
    tax_included: { type: Boolean, default: false },
  },
  last_sync:  { type: Date, default: null },
  last_error: { type: String, default: null },
  sync_log:   { type: [syncLogEntrySchema], default: [] },
}, { timestamps: true })

erpIntegrationSchema.index({ workspace_id: 1, provider: 1 }, { unique: true })

module.exports = mongoose.model('ERPIntegration', erpIntegrationSchema)
