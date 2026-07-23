'use strict'

const Workspace       = require('../../db/models/workspace')
const WorkspaceMember = require('../../db/models/workspace-member')
const Plan            = require('../../db/models/plan')
const PlanDefinition  = require('../../db/models/plan-definition')
const Channel         = require('../../db/models/channel')
const Invoice         = require('../../db/models/invoice')
const KnowledgeItem   = require('../../db/models/knowledge-item')
const BotAgent        = require('../../db/models/bot-agent')
const Conversation    = require('../../db/models/conversation')
const { errorResponse } = require('../../schemas/common')

// ─── Schemas reutilizables ────────────────────────────────────────────────────

const PlanSummary = {
  type: 'object',
  additionalProperties: true,
  properties: {
    tier:   { type: 'string' },
    status: { type: 'string' },
    limits: { type: 'object', additionalProperties: true },
    usage:  { type: 'object', additionalProperties: true },
    trial_ends_at:    { type: 'string', nullable: true },
    suspended_at:     { type: 'string', nullable: true },
    suspension_reason: { type: 'string', nullable: true },
    billing_cycle:    { type: 'string', nullable: true },
    next_billing_date: { type: 'string', nullable: true },
  },
}

const WorkspaceSummary = {
  type: 'object',
  additionalProperties: true,
  properties: {
    _id:       { type: 'string' },
    name:      { type: 'string' },
    slug:      { type: 'string' },
    active:    { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    owner: {
      type: 'object',
      nullable: true,
      additionalProperties: true,
      properties: {
        _id:   { type: 'string' },
        name:  { type: 'string' },
        email: { type: 'string' },
      },
    },
    plan: PlanSummary,
    channels_count: { type: 'integer' },
    members_count:  { type: 'integer' },
  },
}

async function superAdminWorkspacesRoutes(fastify) {
  const preHandler     = [fastify.authenticateSuperAdmin]
  const adminPreHandler = [fastify.authenticateSuperAdmin, fastify.requireSuperAdminRole]

  // ─── GET /superadmin/workspaces ───────────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Workspaces'],
      summary: 'Listar todos los workspaces',
      security: [{ BearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page:   { type: 'integer', default: 1, minimum: 1 },
          limit:  { type: 'integer', default: 20, minimum: 1, maximum: 100 },
          search: { type: 'string', description: 'Buscar por nombre, slug o email de owner' },
          tier:   { type: 'string', enum: ['free', 'starter', 'pro', 'enterprise'] },
          status: { type: 'string', enum: ['active', 'trialing', 'past_due', 'suspended', 'canceled'] },
          sort:   { type: 'string', enum: ['createdAt', 'name', 'usage'], default: 'createdAt' },
          order:  { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data:  { type: 'array', items: WorkspaceSummary },
            total: { type: 'integer' },
            page:  { type: 'integer' },
            pages: { type: 'integer' },
          },
        },
      },
    },
  }, async (request) => {
    const { page = 1, limit = 20, search, tier, status, sort = 'createdAt', order = 'desc' } = request.query
    const skip = (page - 1) * limit

    // Filtrar plans por tier/status primero
    const planFilter = {}
    if (tier)   planFilter.tier   = tier
    if (status) planFilter.status = status

    let workspaceIdFilter = null
    if (tier || status) {
      const plans = await Plan.find(planFilter, 'workspace_id').lean()
      workspaceIdFilter = plans.map(p => p.workspace_id)
    }

    // Filtro de workspace
    const wsFilter = {}
    if (workspaceIdFilter) wsFilter._id = { $in: workspaceIdFilter }
    if (search) {
      wsFilter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { slug: { $regex: search, $options: 'i' } },
      ]
    }

    // Ordenamiento
    const sortMap = { createdAt: { createdAt: order === 'asc' ? 1 : -1 }, name: { name: order === 'asc' ? 1 : -1 } }
    const sortObj = sortMap[sort] ?? { createdAt: -1 }

    const [workspaces, total] = await Promise.all([
      Workspace.find(wsFilter).sort(sortObj).skip(skip).limit(limit).lean(),
      Workspace.countDocuments(wsFilter),
    ])

    const wsIds = workspaces.map(w => w._id)

    // Cargar datos relacionados en paralelo
    const [plans, memberCounts, channelCounts, owners] = await Promise.all([
      Plan.find({ workspace_id: { $in: wsIds } }).lean(),
      WorkspaceMember.aggregate([
        { $match: { workspace_id: { $in: wsIds }, active: true } },
        { $group: { _id: '$workspace_id', count: { $sum: 1 } } },
      ]),
      Channel.aggregate([
        { $match: { workspace_id: { $in: wsIds } } },
        { $group: { _id: '$workspace_id', count: { $sum: 1 } } },
      ]),
      WorkspaceMember.find({ workspace_id: { $in: wsIds }, role: 'owner' })
        .populate('user_id', 'name email')
        .lean(),
    ])

    const planMap    = Object.fromEntries(plans.map(p => [p.workspace_id.toString(), p]))
    const memberMap  = Object.fromEntries(memberCounts.map(m => [m._id.toString(), m.count]))
    const channelMap = Object.fromEntries(channelCounts.map(c => [c._id.toString(), c.count]))
    const ownerMap   = Object.fromEntries(owners.map(o => [o.workspace_id.toString(), o.user_id]))

    const data = workspaces.map(w => {
      const id = w._id.toString()
      return {
        _id:            w._id,
        name:           w.name,
        slug:           w.slug,
        active:         w.active,
        createdAt:      w.createdAt,
        owner:          ownerMap[id] ?? null,
        plan:           planMap[id] ?? null,
        members_count:  memberMap[id] ?? 0,
        channels_count: channelMap[id] ?? 0,
      }
    })

    return { data, total, page, pages: Math.ceil(total / limit) }
  })

  // ─── GET /superadmin/workspaces/:id ──────────────────────────────────────
  fastify.get('/:id', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Workspaces'],
      summary: 'Detalle completo de un workspace',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
        },
        404: { description: 'Workspace no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const workspace = await Workspace.findById(request.params.id).lean()
    if (!workspace) return reply.code(404).send({ error: 'Workspace no encontrado' })

    // Calcular inicio del mes actual para contar conversaciones
    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const [plan, members, channels, invoices,
      agentCount, knowledgeCount, botCount, conversationsThisMonth] = await Promise.all([
      Plan.findOne({ workspace_id: workspace._id }).lean(),
      WorkspaceMember.find({ workspace_id: workspace._id })
        .populate('user_id', 'name email avatar_url')
        .lean(),
      Channel.find({ workspace_id: workspace._id }).lean(),
      Invoice.find({ workspace_id: workspace._id }).sort({ createdAt: -1 }).limit(10).lean(),
      // Conteos en vivo para la sección Plan & Uso
      WorkspaceMember.countDocuments({ workspace_id: workspace._id, active: true, role: { $in: ['owner', 'admin', 'agent'] } }),
      KnowledgeItem.countDocuments({ workspace_id: workspace._id }),
      BotAgent.countDocuments({ workspace_id: workspace._id }),
      // Conversaciones creadas este mes (COUNT real, no el contador almacenado)
      Conversation.countDocuments({ workspace_id: workspace._id, createdAt: { $gte: startOfMonth } }),
    ])

    // Sincronizar el contador almacenado con el real (corrige datos históricos)
    if (plan && plan.usage?.conversations_this_month !== conversationsThisMonth) {
      Plan.updateOne(
        { workspace_id: workspace._id },
        { $set: { 'usage.conversations_this_month': conversationsThisMonth, 'usage.period_start': startOfMonth } }
      ).catch(() => {}) // fire-and-forget, no bloquear la respuesta
    }

    // Enriquecer plan.usage con conteos en vivo (lo que no está almacenado)
    const enrichedPlan = plan ? {
      ...plan,
      usage: {
        conversations_this_month: conversationsThisMonth,
        agents:          agentCount,
        channels:        channels.length,
        knowledge_items: knowledgeCount,
        bots:            botCount,
        storage_gb:      plan.usage?.storage_gb ?? 0,
      },
    } : null

    return {
      ...workspace,
      plan: enrichedPlan,
      members: members.map(m => ({
        _id:    m._id,
        user:   m.user_id,
        role:   m.role,
        active: m.active,
      })),
      channels,
      recent_invoices: invoices,
    }
  })

  // ─── POST /superadmin/workspaces/:id/plan ─────────────────────────────────
  fastify.post('/:id/plan', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Workspaces'],
      summary: 'Cambiar plan de un workspace manualmente',
      description: 'Override manual del tier y límites. No pasa por Stripe.',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['tier'],
        properties: {
          tier:   { type: 'string', enum: ['free', 'starter', 'pro', 'enterprise'] },
          note:   { type: 'string', description: 'Razón del cambio manual' },
          billing_cycle: { type: 'string', enum: ['monthly', 'yearly', null] },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { description: 'Plan no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { tier, note, billing_cycle } = request.body

    // Cargar límites desde PlanDefinition
    const planDef = await PlanDefinition.findOne({ tier }).lean()

    const plan = await Plan.findOne({ workspace_id: request.params.id })
    if (!plan) return reply.code(404).send({ error: 'Plan no encontrado para este workspace' })

    plan.tier          = tier
    plan.override_by   = request.superAdmin.email
    plan.override_note = note ?? null
    plan.status        = plan.status === 'suspended' ? 'suspended' : 'active'
    if (billing_cycle !== undefined) plan.billing_cycle = billing_cycle

    if (planDef) {
      plan.limits             = { ...planDef.limits }
      plan.plan_definition_id = planDef._id
    }

    await plan.save()
    return plan.toObject()
  })

  // ─── POST /superadmin/workspaces/:id/suspend ──────────────────────────────
  fastify.post('/:id/suspend', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Workspaces'],
      summary: 'Suspender un workspace',
      description: 'Bloquea el acceso al workspace. Los datos se conservan.',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['reason'],
        properties: {
          reason: { type: 'string', minLength: 5, description: 'Razón de la suspensión (obligatoria)' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { description: 'Plan no encontrado', ...errorResponse },
        409: { description: 'El workspace ya está suspendido', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const plan = await Plan.findOne({ workspace_id: request.params.id })
    if (!plan) return reply.code(404).send({ error: 'Plan no encontrado para este workspace' })
    if (plan.status === 'suspended') return reply.code(409).send({ error: 'El workspace ya esta suspendido' })

    plan.status           = 'suspended'
    plan.suspended_at     = new Date()
    plan.suspension_reason = request.body.reason
    plan.override_by      = request.superAdmin.email
    await plan.save()

    return plan.toObject()
  })

  // ─── POST /superadmin/workspaces/:id/activate ─────────────────────────────
  fastify.post('/:id/activate', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Workspaces'],
      summary: 'Reactivar un workspace suspendido',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'Nota sobre la reactivación (opcional)' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { description: 'Plan no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const plan = await Plan.findOne({ workspace_id: request.params.id })
    if (!plan) return reply.code(404).send({ error: 'Plan no encontrado para este workspace' })

    plan.status           = 'active'
    plan.suspended_at     = null
    plan.suspension_reason = null
    plan.override_by      = request.superAdmin.email
    plan.override_note    = request.body?.note ?? `Reactivado por ${request.superAdmin.email}`
    await plan.save()

    return plan.toObject()
  })

  // ─── POST /superadmin/workspaces/:id/trial ────────────────────────────────
  fastify.post('/:id/trial', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Workspaces'],
      summary: 'Otorgar días de trial a un workspace',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['days', 'tier'],
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 365, description: 'Días de trial a otorgar' },
          tier: { type: 'string', enum: ['starter', 'pro', 'enterprise'], description: 'Tier del trial' },
          note: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { description: 'Plan no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { days, tier, note } = request.body

    const plan = await Plan.findOne({ workspace_id: request.params.id })
    if (!plan) return reply.code(404).send({ error: 'Plan no encontrado para este workspace' })

    const planDef = await PlanDefinition.findOne({ tier }).lean()

    const trialStart = new Date()
    const trialEnd   = new Date(trialStart.getTime() + days * 24 * 60 * 60 * 1000)

    plan.tier             = tier
    plan.status           = 'trialing'
    plan.trial_started_at = trialStart
    plan.trial_ends_at    = trialEnd
    plan.override_by      = request.superAdmin.email
    plan.override_note    = note ?? `Trial de ${days} dias otorgado por ${request.superAdmin.email}`

    if (planDef) {
      plan.limits             = { ...planDef.limits }
      plan.plan_definition_id = planDef._id
    }

    await plan.save()
    return plan.toObject()
  })

  // ─── POST /superadmin/workspaces/:id/reset-usage ──────────────────────────
  fastify.post('/:id/reset-usage', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Workspaces'],
      summary: 'Resetear contador de uso del mes',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { description: 'Plan no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const plan = await Plan.findOne({ workspace_id: request.params.id })
    if (!plan) return reply.code(404).send({ error: 'Plan no encontrado para este workspace' })

    plan.usage.conversations_this_month = 0
    plan.usage.period_start = new Date()
    plan.override_by   = request.superAdmin.email
    plan.override_note = `Uso reseteado manualmente por ${request.superAdmin.email}`
    await plan.save()

    return plan.toObject()
  })

  // ─── DELETE /superadmin/workspaces/:id ───────────────────────────────────
  fastify.delete('/:id', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Workspaces'],
      summary: 'Eliminar un workspace y todos sus datos',
      description: 'Elimina el workspace y en cascada: miembros, plan, canales, facturas, bots, documentos de conocimiento y conversaciones. Esta acción es IRREVERSIBLE.',
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
            ok:      { type: 'boolean' },
            message: { type: 'string' },
            deleted: { type: 'object', additionalProperties: true },
          },
        },
        404: { description: 'Workspace no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params

    const workspace = await Workspace.findById(id).lean()
    if (!workspace) return reply.code(404).send({ error: 'Workspace no encontrado' })

    // Eliminar todos los datos relacionados en paralelo
    const [members, plans, channels, invoices, bots, knowledge, conversations] = await Promise.all([
      WorkspaceMember.deleteMany({ workspace_id: id }),
      Plan.deleteMany({ workspace_id: id }),
      Channel.deleteMany({ workspace_id: id }),
      Invoice.deleteMany({ workspace_id: id }),
      BotAgent.deleteMany({ workspace_id: id }),
      KnowledgeItem.deleteMany({ workspace_id: id }),
      Conversation.deleteMany({ workspace_id: id }),
    ])

    // Eliminar el workspace
    await Workspace.findByIdAndDelete(id)

    return {
      ok: true,
      message: `Workspace "${workspace.name}" eliminado permanentemente`,
      deleted: {
        members:       members.deletedCount,
        plans:         plans.deletedCount,
        channels:      channels.deletedCount,
        invoices:      invoices.deletedCount,
        bots:          bots.deletedCount,
        knowledge:     knowledge.deletedCount,
        conversations: conversations.deletedCount,
      },
    }
  })

  // ─── PATCH /superadmin/workspaces/:id ─────────────────────────────────────
  fastify.patch('/:id', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Workspaces'],
      summary: 'Editar datos de un workspace',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          name:   { type: 'string', minLength: 2 },
          active: { type: 'boolean' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { description: 'Workspace no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const allowed = {}
    if (request.body.name   !== undefined) allowed.name   = request.body.name
    if (request.body.active !== undefined) allowed.active = request.body.active

    const workspace = await Workspace.findByIdAndUpdate(
      request.params.id,
      { $set: allowed },
      { new: true, runValidators: true }
    ).lean()

    if (!workspace) return reply.code(404).send({ error: 'Workspace no encontrado' })
    return workspace
  })
}

module.exports = superAdminWorkspacesRoutes
