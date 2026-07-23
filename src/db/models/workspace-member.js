'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const workspaceMemberSchema = new Schema({
  workspace_id:  { type: Schema.Types.ObjectId, ref: 'Workspace',  required: true },
  user_id:       { type: Schema.Types.ObjectId, ref: 'User',       required: true },
  department_id: { type: Schema.Types.ObjectId, ref: 'Department', default: null },
  role:          { type: String, enum: ['owner', 'admin', 'agent', 'viewer'], default: 'agent' },
  active:        { type: Boolean, default: true },
  last_active_at:{ type: Date, default: null },
}, { timestamps: true })

workspaceMemberSchema.index({ workspace_id: 1, user_id: 1 }, { unique: true })
workspaceMemberSchema.index({ workspace_id: 1, role: 1 })
workspaceMemberSchema.index({ user_id: 1 })

module.exports = mongoose.model('WorkspaceMember', workspaceMemberSchema)
