'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

/**
 * Product — catálogo de productos por workspace.
 * Usados por el bot de ventas para generar links de pago.
 */
const productSchema = new Schema({
  workspace_id: {
    type: Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 200,
  },
  description: {
    type: String,
    default: '',
    maxlength: 2000,
  },
  price: {
    type: Number,
    required: true,
    min: 0,
  },
  currency: {
    type: String,
    default: 'USD',
    uppercase: true,
    maxlength: 3,
  },
  images: {
    type: [String],
    default: [],
  },
  sku: {
    type: String,
    default: null,
    trim: true,
  },
  active: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true })

productSchema.index({ workspace_id: 1, active: 1 })

module.exports = mongoose.model('Product', productSchema)
