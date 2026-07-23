'use strict'

const Coupon = require('../../db/models/coupon')
const Plan   = require('../../db/models/plan')
const { errorResponse } = require('../../schemas/common')

const CouponObject = {
  type: 'object',
  additionalProperties: true,
  properties: {
    _id:         { type: 'string' },
    code:        { type: 'string' },
    description: { type: 'string' },
    type:        { type: 'string', enum: ['percent', 'fixed_amount', 'free_trial_days'] },
    value:       { type: 'number' },
    applies_to:  { type: 'string', enum: ['all', 'specific_tiers'] },
    applicable_tiers: { type: 'array', items: { type: 'string' } },
    max_uses:    { type: 'integer', nullable: true },
    used_count:  { type: 'integer' },
    valid_from:  { type: 'string', format: 'date-time' },
    valid_until: { type: 'string', format: 'date-time', nullable: true },
    active:      { type: 'boolean' },
    stripe_coupon_id: { type: 'string', nullable: true },
    createdAt:   { type: 'string', format: 'date-time' },
    updatedAt:   { type: 'string', format: 'date-time' },
  },
}

const CouponBodySchema = {
  type: 'object',
  properties: {
    code:        { type: 'string', minLength: 2, maxLength: 50, description: 'Se convierte a MAYÚSCULAS automáticamente' },
    description: { type: 'string' },
    type:        { type: 'string', enum: ['percent', 'fixed_amount', 'free_trial_days'] },
    value: {
      type: 'number',
      minimum: 0,
      description: 'Porcentaje (0-100), centavos USD, o número de días según el tipo',
    },
    applies_to:  { type: 'string', enum: ['all', 'specific_tiers'], default: 'all' },
    applicable_tiers: {
      type: 'array',
      items: { type: 'string', enum: ['free', 'starter', 'pro', 'enterprise'] },
    },
    max_uses:    { type: 'integer', minimum: 1, nullable: true, description: 'null = ilimitado' },
    valid_from:  { type: 'string', format: 'date-time' },
    valid_until: { type: 'string', format: 'date-time', nullable: true },
    active:      { type: 'boolean' },
  },
}

async function superAdminCouponsRoutes(fastify) {
  const preHandler      = [fastify.authenticateSuperAdmin]
  const adminPreHandler = [fastify.authenticateSuperAdmin, fastify.requireSuperAdminRole]

  // ─── GET /superadmin/coupons ──────────────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Coupons'],
      summary: 'Listar cupones',
      security: [{ BearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page:   { type: 'integer', default: 1, minimum: 1 },
          limit:  { type: 'integer', default: 20, minimum: 1, maximum: 100 },
          active: { type: 'boolean' },
          search: { type: 'string', description: 'Buscar por code o descripción' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data:  { type: 'array', items: CouponObject },
            total: { type: 'integer' },
            page:  { type: 'integer' },
            pages: { type: 'integer' },
          },
        },
      },
    },
  }, async (request) => {
    const { page = 1, limit = 20, active, search } = request.query
    const skip = (page - 1) * limit
    const filter = {}

    if (active !== undefined) filter.active = active
    if (search) {
      filter.$or = [
        { code:        { $regex: search.toUpperCase(), $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ]
    }

    const [data, total] = await Promise.all([
      Coupon.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Coupon.countDocuments(filter),
    ])

    return { data, total, page, pages: Math.ceil(total / limit) }
  })

  // ─── GET /superadmin/coupons/:id ──────────────────────────────────────────
  fastify.get('/:id', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Coupons'],
      summary: 'Detalle de un cupón',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      response: {
        200: CouponObject,
        404: { description: 'Cupón no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const coupon = await Coupon.findById(request.params.id).lean()
    if (!coupon) return reply.code(404).send({ error: 'Cupon no encontrado' })
    return coupon
  })

  // ─── GET /superadmin/coupons/:id/uses ─────────────────────────────────────
  fastify.get('/:id/uses', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Coupons'],
      summary: 'Workspaces que usaron este cupón',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            coupon_code: { type: 'string' },
            used_count:  { type: 'integer' },
            workspaces: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  workspace_id: { type: 'string' },
                  name: { type: 'string' },
                  slug: { type: 'string' },
                  tier: { type: 'string' },
                  applied_at: { type: 'string' },
                },
              },
            },
          },
        },
        404: { description: 'Cupón no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const coupon = await Coupon.findById(request.params.id).lean()
    if (!coupon) return reply.code(404).send({ error: 'Cupon no encontrado' })

    const plans = await Plan
      .find({ coupon_applied: coupon.code })
      .populate('workspace_id', 'name slug')
      .lean()

    const workspaces = plans.map(p => ({
      workspace_id: p.workspace_id?._id,
      name: p.workspace_id?.name ?? '(eliminado)',
      slug: p.workspace_id?.slug ?? '',
      tier: p.tier,
      applied_at: p.updatedAt,
    }))

    return { coupon_code: coupon.code, used_count: coupon.used_count, workspaces }
  })

  // ─── POST /superadmin/coupons ─────────────────────────────────────────────
  fastify.post('/', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Coupons'],
      summary: 'Crear cupón',
      security: [{ BearerAuth: [] }],
      body: {
        ...CouponBodySchema,
        required: ['code', 'type', 'value'],
      },
      response: {
        201: CouponObject,
        409: { description: 'Código ya existe', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const code = request.body.code.toUpperCase().trim()

    const existing = await Coupon.findOne({ code })
    if (existing) return reply.code(409).send({ error: `El codigo "${code}" ya existe` })

    const coupon = await Coupon.create({ ...request.body, code })
    return reply.code(201).send(coupon.toObject())
  })

  // ─── PATCH /superadmin/coupons/:id ────────────────────────────────────────
  fastify.patch('/:id', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Coupons'],
      summary: 'Actualizar cupón',
      description: 'No se puede cambiar el código. Permite activar/desactivar, extender fecha, modificar límite de usos.',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          max_uses:    { type: 'integer', minimum: 1, nullable: true },
          valid_until: { type: 'string', format: 'date-time', nullable: true },
          active:      { type: 'boolean' },
        },
      },
      response: {
        200: CouponObject,
        404: { description: 'Cupón no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    // Solo permitir campos editables (no code, type, value)
    const allowed = {}
    const editable = ['description', 'max_uses', 'valid_until', 'active']
    for (const key of editable) {
      if (request.body[key] !== undefined) allowed[key] = request.body[key]
    }

    const coupon = await Coupon.findByIdAndUpdate(
      request.params.id,
      { $set: allowed },
      { new: true }
    ).lean()

    if (!coupon) return reply.code(404).send({ error: 'Cupon no encontrado' })
    return coupon
  })

  // ─── DELETE /superadmin/coupons/:id ──────────────────────────────────────
  fastify.delete('/:id', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Coupons'],
      summary: 'Desactivar cupón',
      description: 'Marca el cupón como inactivo. No se elimina para mantener historial.',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      response: {
        200: { type: 'object', properties: { message: { type: 'string' } } },
        404: { description: 'Cupón no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const coupon = await Coupon.findByIdAndUpdate(
      request.params.id,
      { $set: { active: false } },
      { new: true }
    )
    if (!coupon) return reply.code(404).send({ error: 'Cupon no encontrado' })
    return { message: `Cupon "${coupon.code}" desactivado correctamente` }
  })

  // ─── POST /superadmin/coupons/validate ────────────────────────────────────
  fastify.post('/validate', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Coupons'],
      summary: 'Validar un cupón',
      description: 'Verifica si un código de cupón es válido para un tier dado. No incrementa el contador de uso.',
      security: [{ BearerAuth: [] }],
      body: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string' },
          tier: { type: 'string', enum: ['free', 'starter', 'pro', 'enterprise'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid:   { type: 'boolean' },
            reason:  { type: 'string', nullable: true },
            coupon:  { ...CouponObject, nullable: true },
          },
        },
      },
    },
  }, async (request) => {
    const { code, tier } = request.body
    const now = new Date()

    const coupon = await Coupon.findOne({ code: code.toUpperCase() }).lean()

    if (!coupon) return { valid: false, reason: 'Codigo no encontrado', coupon: null }
    if (!coupon.active) return { valid: false, reason: 'Cupon inactivo', coupon: null }
    if (coupon.valid_until && coupon.valid_until < now) return { valid: false, reason: 'Cupon expirado', coupon: null }
    if (coupon.valid_from > now) return { valid: false, reason: 'Cupon aun no vigente', coupon: null }
    if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) {
      return { valid: false, reason: 'Cupon sin usos disponibles', coupon: null }
    }
    if (tier && coupon.applies_to === 'specific_tiers' && !coupon.applicable_tiers.includes(tier)) {
      return { valid: false, reason: `Cupon no aplica para el tier "${tier}"`, coupon: null }
    }

    return { valid: true, reason: null, coupon }
  })
}

module.exports = superAdminCouponsRoutes
