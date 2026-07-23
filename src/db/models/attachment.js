'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const attachmentSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  message_id: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
  type: { type: String, enum: ['image', 'audio', 'video', 'document', 'voice_note'], required: true },
  filename: { type: String, required: true },
  mime_type: { type: String, required: true },
  size_bytes: { type: Number, default: null },
  url: { type: String, required: true },
  s3_key: { type: String, required: true },
  transcript: { type: String, default: null },
  duration_s: { type: Number, default: null },
}, { timestamps: true })

attachmentSchema.index({ workspace_id: 1, message_id: 1 })

module.exports = mongoose.model('Attachment', attachmentSchema)
