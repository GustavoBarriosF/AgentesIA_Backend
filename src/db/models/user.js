'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const userSchema = new Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password_hash: { type: String, default: null },
  name: { type: String, required: true, trim: true },
  avatar_url: { type: String, default: null },
  provider: { type: String, enum: ['local', 'google', 'github'], default: 'local' },
  provider_id: { type: String, default: null },
  verified: { type: Boolean, default: false },
  verification_token: { type: String, default: null },
  reset_token: { type: String, default: null },
  reset_token_expires: { type: Date, default: null },
}, { timestamps: true })

module.exports = mongoose.model('User', userSchema)
