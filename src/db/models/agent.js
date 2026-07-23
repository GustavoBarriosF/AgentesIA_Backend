'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const agentSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  user_id: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  status: { type: String, enum: ['online', 'away', 'offline'], default: 'offline' },
  skills: [{ type: String, trim: true }],
  max_chats: { type: Number, default: 5 },
  active_chats: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true })

agentSchema.index({ workspace_id: 1, status: 1 })
agentSchema.index({ workspace_id: 1, user_id: 1 }, { unique: true })

module.exports = mongoose.model('Agent', agentSchema)
