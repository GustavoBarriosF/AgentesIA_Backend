'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

/**
 * Department – Departamentos del workspace para organizar el equipo.
 * Cada workspace puede crear sus propios departamentos.
 */
const departmentSchema = new Schema({
  workspace_id: {
    type: Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    default: '',
    trim: true,
  },
  color: {
    type: String,
    default: '#6366f1',
  },
}, { timestamps: true })

departmentSchema.index({ workspace_id: 1 })
departmentSchema.index({ workspace_id: 1, name: 1 }, { unique: true })

module.exports = mongoose.model('Department', departmentSchema)
