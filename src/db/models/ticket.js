'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const ticketSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  ticket_number: { type: Number, default: null },
  contact_id: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
  conversation_id: { type: Schema.Types.ObjectId, ref: 'Conversation', default: null },
  assigned_to: { type: Schema.Types.ObjectId, ref: 'Agent', default: null },
  department_id: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  status: {
    type: String,
    enum: ['open', 'in_progress', 'waiting', 'resolved', 'closed'],
    default: 'open',
  },
  sla_breach: { type: Boolean, default: false },
  sla_due_at: { type: Date, default: null },
  resolved_at: { type: Date, default: null },
  internal_notes: [
    {
      content: String,
      author_id: { type: Schema.Types.ObjectId, ref: 'User' },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  public_notes: [
    {
      content: String,
      author_id: { type: Schema.Types.ObjectId, ref: 'User' },
      createdAt: { type: Date, default: Date.now },
    },
  ],
  tags: [{ type: String, trim: true }],
}, { timestamps: true })

ticketSchema.index({ workspace_id: 1, ticket_number: 1 }, { unique: true, sparse: true })
ticketSchema.index({ workspace_id: 1, status: 1, createdAt: -1 })
ticketSchema.index({ workspace_id: 1, assigned_to: 1, status: 1 })
ticketSchema.index({ workspace_id: 1, department_id: 1, status: 1 })
ticketSchema.index({ workspace_id: 1, sla_breach: 1 })
ticketSchema.index({ workspace_id: 1, contact_id: 1 })

module.exports = mongoose.model('Ticket', ticketSchema)
