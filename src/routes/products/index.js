'use strict'

/**
 * products routes
 *
 * GET    /api/:workspaceId/products        → listar productos del workspace
 * POST   /api/:workspaceId/products        → crear producto
 * PUT    /api/:workspaceId/products/:id    → actualizar producto
 * DELETE /api/:workspaceId/products/:id    → desactivar producto
 */

const Product = require('../../db/models/product')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

const ProductObject = {
  type: 'object',
  properties: {
    _id:         { type: 'string' },
    workspace_id:{ type: 'string' },
    name:        { type: 'string' },
    description: { type: 'string' },
    price:       { type: 'number' },
    currency:    { type: 'string' },
    images:      { type: 'array', items: { type: 'string' } },
    sku:         { type: 'string', nullable: true },
    active:      { type: 'boolean' },
    createdAt:   { type: 'string', format: 'date-time' },
    updatedAt:   { type: 'string', format: 'date-time' },
  },
}

async function productsRoutes(fastify) {
  const preHandler   = [fastify.authenticate, fastify.requireWorkspace]
  const adminHandler = [...preHandler, fastify.requireRole('admin')]

  // ─── GET /api/:workspaceId/products ───────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Products'],
      summary: 'Listar productos del workspace',
      security,
      params: workspaceParam,
      querystring: {
        type: 'object',
        properties: {
          active: { type: 'boolean' },
          limit:  { type: 'integer', default: 50 },
          offset: { type: 'integer', default: 0 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data:  { type: 'array', items: ProductObject },
            total: { type: 'integer' },
          },
        },
      },
    },
  }, async (request) => {
    const { active, limit = 50, offset = 0 } = request.query
    const query = { workspace_id: request.workspaceId }
    if (active !== undefined) query.active = active

    const [data, total] = await Promise.all([
      Product.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
      Product.countDocuments(query),
    ])

    return { data, total }
  })

  // ─── POST /api/:workspaceId/products ──────────────────────────────────────
  fastify.post('/', {
    preHandler: adminHandler,
    schema: {
      tags: ['Products'],
      summary: 'Crear producto',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['name', 'price'],
        properties: {
          name:        { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 2000 },
          price:       { type: 'number', minimum: 0 },
          currency:    { type: 'string', default: 'USD', maxLength: 3 },
          images:      { type: 'array', items: { type: 'string' } },
          sku:         { type: 'string' },
        },
      },
      response: { 201: ProductObject, 400: errorResponse },
    },
  }, async (request, reply) => {
    const product = await Product.create({
      workspace_id: request.workspaceId,
      ...request.body,
    })
    return reply.code(201).send(product.toObject())
  })

  // ─── PUT /api/:workspaceId/products/:id ───────────────────────────────────
  fastify.put('/:id', {
    preHandler: adminHandler,
    schema: {
      tags: ['Products'],
      summary: 'Actualizar producto',
      security,
      params: { ...workspaceParam, properties: { ...workspaceParam.properties, id: { type: 'string' } } },
      body: {
        type: 'object',
        properties: {
          name:        { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 2000 },
          price:       { type: 'number', minimum: 0 },
          currency:    { type: 'string', maxLength: 3 },
          images:      { type: 'array', items: { type: 'string' } },
          sku:         { type: 'string' },
          active:      { type: 'boolean' },
        },
      },
      response: { 200: ProductObject, 404: errorResponse },
    },
  }, async (request, reply) => {
    const product = await Product.findOneAndUpdate(
      { _id: request.params.id, workspace_id: request.workspaceId },
      { $set: request.body },
      { new: true }
    )
    if (!product) return reply.code(404).send({ error: 'Producto no encontrado' })
    return product.toObject()
  })

  // ─── DELETE /api/:workspaceId/products/:id ────────────────────────────────
  fastify.delete('/:id', {
    preHandler: adminHandler,
    schema: {
      tags: ['Products'],
      summary: 'Desactivar producto',
      security,
      params: { ...workspaceParam, properties: { ...workspaceParam.properties, id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { ok: { type: 'boolean' } } }, 404: errorResponse },
    },
  }, async (request, reply) => {
    const result = await Product.findOneAndUpdate(
      { _id: request.params.id, workspace_id: request.workspaceId },
      { $set: { active: false } }
    )
    if (!result) return reply.code(404).send({ error: 'Producto no encontrado' })
    return { ok: true }
  })
}

module.exports = productsRoutes
