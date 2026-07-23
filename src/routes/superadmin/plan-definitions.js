'use strict'

const PlanDefinition = require('../../db/models/plan-definition')
const Plan           = require('../../db/models/plan')
const { errorResponse } = require('../../schemas/common')

const PlanDefinitionObject = {
  type: 'object',
  additionalProperties: true,
  properties: {
    _id:         { type: 'string' },
    tier:        { type: 'string', enum: ['free', 'starter', 'pro', 'enterprise'] },
    name:        { type: 'string' },
    description: { type: 'string' },
    price_monthly: { type: 'number' },
    price_yearly:  { type: 'number' },
    stripe_price_id_monthly: { type: 'string', nullable: true },
    stripe_price_id_yearly:  { type: 'string', nullable: true },
    stripe_product_id:       { type: 'string', nullable: true },
    limits: {
      type: 'object',
      additionalProperties: true,
    },
    features:    { type: 'array', items: { type: 'string' } },
    trial_days:  { type: 'integer' },
    active:      { type: 'boolean' },
    sort_order:  { type: 'integer' },
    workspaces_count: { type: 'integer' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

const PlanBodySchema = {
  type: 'object',
  properties: {
    name:        { type: 'string', minLength: 1 },
    description: { type: 'string' },
    price_monthly: { type: 'number', minimum: 0, description: 'Precio mensual en centavos USD' },
    price_yearly:  { type: 'number', minimum: 0, description: 'Precio anual en centavos USD' },
    stripe_price_id_monthly: { type: 'string', nullable: true },
    stripe_price_id_yearly:  { type: 'string', nullable: true },
    stripe_product_id:       { type: 'string', nullable: true },
    limits: {
      type: 'object',
      properties: {
        conversations_per_month: { type: 'integer', description: '-1 = ilimitado' },
        agents:          { type: 'integer', description: '-1 = ilimitado' },
        channels:        { type: 'integer', description: '-1 = ilimitado' },
        storage_gb:      { type: 'number' },
        knowledge_items: { type: 'integer', description: '-1 = ilimitado' },
        bots:            { type: 'integer', description: '-1 = ilimitado' },
      },
    },
    features:   { type: 'array', items: { type: 'string' } },
    trial_days: { type: 'integer', minimum: 0 },
    active:     { type: 'boolean' },
    sort_order: { type: 'integer' },
  },
}

async function superAdminPlanDefinitionsRoutes(fastify) {
  const preHandler      = [fastify.authenticateSuperAdmin]
  const adminPreHandler = [fastify.authenticateSuperAdmin, fastify.requireSuperAdminRole]

  // ─── GET /superadmin/plan-definitions ────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Plan Definitions'],
      summary: 'Listar definiciones de planes',
      description: 'Retorna los 4 planes (free/starter/pro/enterprise) con conteo de workspaces en cada uno.',
      security: [{ BearerAuth: [] }],
      response: {
        200: { type: 'array', items: PlanDefinitionObject },
      },
    },
  }, async () => {
    const [definitions, counts] = await Promise.all([
      PlanDefinition.find().sort({ sort_order: 1 }).lean(),
      Plan.aggregate([
        { $group: { _id: '$tier', count: { $sum: 1 } } },
      ]),
    ])

    const countMap = Object.fromEntries(counts.map(c => [c._id, c.count]))

    return definitions.map(d => ({
      ...d,
      workspaces_count: countMap[d.tier] ?? 0,
    }))
  })

  // ─── POST /superadmin/plan-definitions/seed-defaults ─────────────────────
  fastify.post('/seed-defaults', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Plan Definitions'],
      summary: 'Crear planes por defecto',
      description: 'Crea los 4 planes base (free/starter/pro/enterprise) si no existen. Idempotente.',
      security: [{ BearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            created: { type: 'integer' },
            skipped: { type: 'integer' },
            plans:   { type: 'array', items: PlanDefinitionObject },
          },
        },
      },
    },
  }, async () => {
    const DEFAULT_PLANS = [
      {
        tier: 'free',
        name: 'Free',
        description: 'Para equipos pequeños que están comenzando.',
        price_monthly: 0,
        price_yearly:  0,
        limits: { conversations_per_month: 100, agents: 2, channels: 1, storage_gb: 1, knowledge_items: 50, bots: 2 },
        features: [],
        trial_days: 0,
        sort_order: 0,
        active: true,
      },
      {
        tier: 'starter',
        name: 'Starter',
        description: 'Para equipos en crecimiento con más volumen.',
        price_monthly: 2900,  // $29 USD en centavos
        price_yearly:  29000, // $290 USD
        limits: { conversations_per_month: 1000, agents: 5, channels: 3, storage_gb: 5, knowledge_items: 200, bots: 1 },
        features: ['api', 'analytics'],
        trial_days: 14,
        sort_order: 1,
        active: true,
      },
      {
        tier: 'pro',
        name: 'Pro',
        description: 'Para empresas con alto volumen y múltiples canales.',
        price_monthly: 7900,  // $79 USD
        price_yearly:  79000, // $790 USD
        limits: { conversations_per_month: 5000, agents: 20, channels: 10, storage_gb: 20, knowledge_items: 1000, bots: 5 },
        features: ['api', 'analytics', 'whatsapp', 'telegram', 'bot', 'sla'],
        trial_days: 14,
        sort_order: 2,
        active: true,
      },
      {
        tier: 'enterprise',
        name: 'Enterprise',
        description: 'Para grandes organizaciones con necesidades avanzadas.',
        price_monthly: 19900, // $199 USD
        price_yearly:  199000,// $1990 USD
        limits: { conversations_per_month: -1, agents: -1, channels: -1, storage_gb: 100, knowledge_items: -1, bots: -1 },
        features: ['api', 'analytics', 'whatsapp', 'telegram', 'bot', 'sla', 'knowledge_base', 'leads', 'api_access', 'custom_branding'],
        trial_days: 30,
        sort_order: 3,
        active: true,
      },
    ]

    let created = 0
    let skipped = 0

    for (const planData of DEFAULT_PLANS) {
      const exists = await PlanDefinition.findOne({ tier: planData.tier })
      if (exists) {
        skipped++
      } else {
        await PlanDefinition.create(planData)
        created++
      }
    }

    const [plans, counts] = await Promise.all([
      PlanDefinition.find().sort({ sort_order: 1 }).lean(),
      Plan.aggregate([{ $group: { _id: '$tier', count: { $sum: 1 } } }]),
    ])
    const countMap = Object.fromEntries(counts.map(c => [c._id, c.count]))

    return {
      created,
      skipped,
      plans: plans.map(d => ({ ...d, workspaces_count: countMap[d.tier] ?? 0 })),
    }
  })

  // ─── GET /superadmin/plan-definitions/:id ─────────────────────────────────
  fastify.get('/:id', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Plan Definitions'],
      summary: 'Obtener una definición de plan',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      response: {
        200: PlanDefinitionObject,
        404: { description: 'No encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const def = await PlanDefinition.findById(request.params.id).lean()
    if (!def) return reply.code(404).send({ error: 'Plan definition no encontrada' })

    const count = await Plan.countDocuments({ tier: def.tier })
    return { ...def, workspaces_count: count }
  })

  // ─── POST /superadmin/plan-definitions ───────────────────────────────────
  fastify.post('/', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Plan Definitions'],
      summary: 'Crear definición de plan',
      description: 'Solo se pueden crear planes con tiers no existentes. En la práctica se usan los 4 por defecto del seed.',
      security: [{ BearerAuth: [] }],
      body: {
        ...PlanBodySchema,
        required: ['tier', 'name'],
        properties: {
          ...PlanBodySchema.properties,
          tier: { type: 'string', enum: ['free', 'starter', 'pro', 'enterprise'] },
        },
      },
      response: {
        201: PlanDefinitionObject,
        409: { description: 'Ya existe un plan con ese tier', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const existing = await PlanDefinition.findOne({ tier: request.body.tier })
    if (existing) return reply.code(409).send({ error: `Ya existe una definicion para el tier "${request.body.tier}"` })

    const def = await PlanDefinition.create(request.body)
    return reply.code(201).send(def.toObject())
  })

  // ─── PATCH /superadmin/plan-definitions/:id ───────────────────────────────
  fastify.patch('/:id', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Plan Definitions'],
      summary: 'Actualizar definición de plan',
      description: 'Actualiza precios, límites o features. **No actualiza automáticamente los planes de workspaces existentes** — usa el endpoint de sincronización para eso.',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: PlanBodySchema,
      response: {
        200: PlanDefinitionObject,
        404: { description: 'No encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const def = await PlanDefinition.findByIdAndUpdate(
      request.params.id,
      { $set: request.body },
      { new: true, runValidators: true }
    ).lean()

    if (!def) return reply.code(404).send({ error: 'Plan definition no encontrada' })
    const count = await Plan.countDocuments({ tier: def.tier })
    return { ...def, workspaces_count: count }
  })

  // ─── POST /superadmin/plan-definitions/:id/sync-limits ───────────────────
  fastify.post('/:id/sync-limits', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Plan Definitions'],
      summary: 'Sincronizar límites a workspaces existentes',
      description: 'Aplica los límites actuales de esta PlanDefinition a **todos los workspaces** que tengan ese tier. No afecta overrides manuales con `plan_definition_id` diferente.',
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
            updated: { type: 'integer', description: 'Número de planes actualizados' },
            tier:    { type: 'string' },
          },
        },
        404: { description: 'No encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const def = await PlanDefinition.findById(request.params.id).lean()
    if (!def) return reply.code(404).send({ error: 'Plan definition no encontrada' })

    const result = await Plan.updateMany(
      { tier: def.tier, plan_definition_id: def._id },
      {
        $set: {
          limits: def.limits,
          'limits.conversations_per_month': def.limits.conversations_per_month,
          'limits.agents':          def.limits.agents,
          'limits.channels':        def.limits.channels,
          'limits.storage_gb':      def.limits.storage_gb,
          'limits.knowledge_items': def.limits.knowledge_items,
          'limits.bots':            def.limits.bots,
        },
      }
    )

    return { updated: result.modifiedCount, tier: def.tier }
  })

  // ─── DELETE /superadmin/plan-definitions/:id ──────────────────────────────
  fastify.delete('/:id', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Plan Definitions'],
      summary: 'Desactivar definición de plan',
      description: 'Marca el plan como inactivo. No se puede eliminar si tiene workspaces activos.',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      response: {
        200: { type: 'object', properties: { message: { type: 'string' } } },
        404: { description: 'No encontrado', ...errorResponse },
        409: { description: 'Tiene workspaces activos', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const def = await PlanDefinition.findById(request.params.id).lean()
    if (!def) return reply.code(404).send({ error: 'Plan definition no encontrada' })

    const activeCount = await Plan.countDocuments({ tier: def.tier, status: { $in: ['active', 'trialing'] } })
    if (activeCount > 0) {
      return reply.code(409).send({
        error: `No se puede desactivar: ${activeCount} workspace(s) activos en el tier "${def.tier}"`,
      })
    }

    await PlanDefinition.findByIdAndUpdate(request.params.id, { $set: { active: false } })
    return { message: `Plan "${def.tier}" desactivado correctamente` }
  })
}

module.exports = superAdminPlanDefinitionsRoutes
