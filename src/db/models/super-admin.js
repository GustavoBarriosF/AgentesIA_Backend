'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const superAdminSchema = new Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password_hash: { type: String, required: true },
  name: { type: String, required: true, trim: true },
  role: {
    type: String,
    enum: ['superadmin', 'support'],
    default: 'superadmin',
  },
  last_login: { type: Date, default: null },
  active: { type: Boolean, default: true },
}, { timestamps: true })

module.exports = mongoose.model('SuperAdmin', superAdminSchema)
