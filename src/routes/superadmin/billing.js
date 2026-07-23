'use strict'

const Invoice   = require('../../db/models/invoice')
const Workspace = require('../../db/models/workspace')
const Plan      = require('../../db/models/plan')
const { errorResponse } = require('../../schemas/common')

const InvoiceObject = {
  type: 'object',
  additionalProperties: true,
  properties: {
    _id:               { type: 'string' },
    workspace_id:      { type: 'string' },
    workspace_name:    { type: 'string' },
    workspace_slug:    { type: 'string' },
    stripe_invoice_id: { type: 'string', nullable: true },
    amount:            { type: 'number', description: 'Monto en centavos USD' },
    currency:          { type: 'string' },
    status:            { type: 'string', enum: ['draft', 'open', 'paid', 'void', 'uncollectible'] },
    period_start:      { type: 'string', format: 'date-time' },
    period_end:        { type: 'string', format: 'date-time' },
    tier:              { type: 'string', nullable: true },
    billing_cycle:     { type: 'string', nullable: true },
    invoice_url:       { type: 'string', nullable: true },
    pdf_url:           { type: 'string', nullable: true },
    items:             { type: 'array', items: { type: 'object', additionalProperties: true } },
    paid_at:           { type: 'string', format: 'date-time', nullable: true },
    notes:             { type: 'string', nullable: true },
    createdAt:         { type: 'string', format: 'date-time' },
  },
}

async function superAdminBillingRoutes(fastify) {
  const preHandler      = [fastify.authenticateSuperAdmin]
  const adminPreHandler = [fastify.authenticateSuperAdmin, fastify.requireSuperAdminRole]

  // ─── GET /superadmin/billing/invoices ─────────────────────────────────────
  fastify.get('/invoices', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Billing'],
      summary: 'Listar todas las facturas',
      description: 'Vista global de todas las facturas de la plataforma con filtros.',
      security: [{ BearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          page:         { type: 'integer', default: 1, minimum: 1 },
          limit:        { type: 'integer', default: 20, minimum: 1, maximum: 100 },
          status:       { type: 'string', enum: ['draft', 'open', 'paid', 'void', 'uncollectible'] },
          workspace_id: { type: 'string', description: 'Filtrar por workspace' },
          date_from:    { type: 'string', format: 'date-time' },
          date_to:      { type: 'string', format: 'date-time' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data:               { type: 'array', items: InvoiceObject },
            total:              { type: 'integer' },
            page:               { type: 'integer' },
            pages:              { type: 'integer' },
            total_amount_cents: { type: 'integer', description: 'Suma total de las facturas filtradas en centavos' },
          },
        },
      },
    },
  }, async (request) => {
    const { page = 1, limit = 20, status, workspace_id, date_from, date_to } = request.query
    const skip = (page - 1) * limit
    const filter = {}

    if (status)       filter.status       = status
    if (workspace_id) filter.workspace_id = workspace_id
    if (date_from || date_to) {
      filter.createdAt = {}
      if (date_from) filter.createdAt.$gte = new Date(date_from)
      if (date_to)   filter.createdAt.$lte = new Date(date_to)
    }

    const [invoices, total, totalAmountResult] = await Promise.all([
      Invoice.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Invoice.countDocuments(filter),
      Invoice.aggregate([
        { $match: filter },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ])

    // Enriquecer con datos de workspace
    const wsIds = [...new Set(invoices.map(i => i.workspace_id?.toString()).filter(Boolean))]
    const workspaces = await Workspace.find({ _id: { $in: wsIds } }, 'name slug').lean()
    const wsMap = Object.fromEntries(workspaces.map(w => [w._id.toString(), w]))

    const data = invoices.map(inv => ({
      ...inv,
      workspace_name: wsMap[inv.workspace_id?.toString()]?.name ?? '(eliminado)',
      workspace_slug: wsMap[inv.workspace_id?.toString()]?.slug ?? '',
    }))

    return {
      data,
      total,
      page,
      pages: Math.ceil(total / limit),
      total_amount_cents: totalAmountResult[0]?.total ?? 0,
    }
  })

  // ─── GET /superadmin/billing/invoices/:id ────────────────────────────────
  fastify.get('/invoices/:id', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Billing'],
      summary: 'Detalle de una factura',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      response: {
        200: InvoiceObject,
        404: { description: 'Factura no encontrada', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const invoice = await Invoice.findById(request.params.id).lean()
    if (!invoice) return reply.code(404).send({ error: 'Factura no encontrada' })

    const workspace = await Workspace.findById(invoice.workspace_id, 'name slug').lean()
    return {
      ...invoice,
      workspace_name: workspace?.name ?? '(eliminado)',
      workspace_slug: workspace?.slug ?? '',
    }
  })

  // ─── GET /superadmin/billing/workspace/:workspaceId ───────────────────────
  fastify.get('/workspace/:workspaceId', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Billing'],
      summary: 'Facturas de un workspace específico',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['workspaceId'],
        properties: { workspaceId: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          page:  { type: 'integer', default: 1, minimum: 1 },
          limit: { type: 'integer', default: 20, minimum: 1, maximum: 100 },
        },
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
          properties: {
            workspace:          { type: 'object', additionalProperties: true },
            plan:               { type: 'object', additionalProperties: true },
            invoices:           { type: 'array', items: InvoiceObject },
            total:              { type: 'integer' },
            total_paid_cents:   { type: 'integer' },
          },
        },
        404: { description: 'Workspace no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { workspaceId } = request.params
    const { page = 1, limit = 20 } = request.query
    const skip = (page - 1) * limit

    const [workspace, plan] = await Promise.all([
      Workspace.findById(workspaceId, 'name slug branding active').lean(),
      Plan.findOne({ workspace_id: workspaceId }).lean(),
    ])

    if (!workspace) return reply.code(404).send({ error: 'Workspace no encontrado' })

    const [invoices, total, paidResult] = await Promise.all([
      Invoice.find({ workspace_id: workspaceId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Invoice.countDocuments({ workspace_id: workspaceId }),
      Invoice.aggregate([
        { $match: { workspace_id: workspaceId, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
    ])

    return {
      workspace,
      plan,
      invoices,
      total,
      total_paid_cents: paidResult[0]?.total ?? 0,
    }
  })

  // ─── POST /superadmin/billing/invoices ────────────────────────────────────
  fastify.post('/invoices', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Billing'],
      summary: 'Crear factura manual',
      description: 'Crea una factura interna (sin Stripe) para un workspace. Útil para registrar pagos manuales o ajustes.',
      security: [{ BearerAuth: [] }],
      body: {
        type: 'object',
        required: ['workspace_id', 'amount', 'period_start', 'period_end'],
        properties: {
          workspace_id: { type: 'string' },
          amount:       { type: 'integer', minimum: 0, description: 'Monto en centavos USD' },
          currency:     { type: 'string', default: 'usd' },
          status:       { type: 'string', enum: ['draft', 'open', 'paid', 'void'], default: 'paid' },
          period_start: { type: 'string', format: 'date-time' },
          period_end:   { type: 'string', format: 'date-time' },
          tier:         { type: 'string' },
          billing_cycle: { type: 'string', enum: ['monthly', 'yearly'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                amount:      { type: 'integer' },
              },
            },
          },
          notes:   { type: 'string' },
          paid_at: { type: 'string', format: 'date-time' },
        },
      },
      response: {
        201: InvoiceObject,
        404: { description: 'Workspace no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const workspace = await Workspace.findById(request.body.workspace_id).lean()
    if (!workspace) return reply.code(404).send({ error: 'Workspace no encontrado' })

    const data = { ...request.body }
    if (data.status === 'paid' && !data.paid_at) data.paid_at = new Date()

    const invoice = await Invoice.create(data)
    return reply.code(201).send({ ...invoice.toObject(), workspace_name: workspace.name, workspace_slug: workspace.slug })
  })

  // ─── PATCH /superadmin/billing/invoices/:id ───────────────────────────────
  fastify.patch('/invoices/:id', {
    preHandler: adminPreHandler,
    schema: {
      tags: ['SuperAdmin — Billing'],
      summary: 'Actualizar estado de una factura',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      body: {
        type: 'object',
        properties: {
          status:  { type: 'string', enum: ['open', 'paid', 'void', 'uncollectible'] },
          paid_at: { type: 'string', format: 'date-time', nullable: true },
          notes:   { type: 'string' },
        },
      },
      response: {
        200: InvoiceObject,
        404: { description: 'Factura no encontrada', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const update = { ...request.body }
    if (update.status === 'paid' && !update.paid_at) update.paid_at = new Date()

    const invoice = await Invoice.findByIdAndUpdate(
      request.params.id,
      { $set: update },
      { new: true }
    ).lean()

    if (!invoice) return reply.code(404).send({ error: 'Factura no encontrada' })

    const workspace = await Workspace.findById(invoice.workspace_id, 'name slug').lean()
    return {
      ...invoice,
      workspace_name: workspace?.name ?? '(eliminado)',
      workspace_slug: workspace?.slug ?? '',
    }
  })

  // ─── GET /superadmin/billing/summary ──────────────────────────────────────
  fastify.get('/summary', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Billing'],
      summary: 'Resumen financiero global',
      security: [{ BearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            this_month: {
              type: 'object',
              properties: {
                revenue_cents:    { type: 'integer' },
                invoices_paid:    { type: 'integer' },
                invoices_open:    { type: 'integer' },
                invoices_overdue: { type: 'integer' },
              },
            },
            last_month: {
              type: 'object',
              properties: {
                revenue_cents: { type: 'integer' },
                invoices_paid: { type: 'integer' },
              },
            },
            all_time: {
              type: 'object',
              properties: {
                total_revenue_cents: { type: 'integer' },
                total_invoices:      { type: 'integer' },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const now            = new Date()
    const startOfMonth   = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfLastMon = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const endOfLastMon   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)

    const [thisMonthPaid, thisMonthOpen, lastMonthPaid, allTime] = await Promise.all([
      Invoice.aggregate([
        { $match: { status: 'paid', paid_at: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Invoice.countDocuments({ status: 'open', createdAt: { $gte: startOfMonth } }),
      Invoice.aggregate([
        { $match: { status: 'paid', paid_at: { $gte: startOfLastMon, $lte: endOfLastMon } } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Invoice.aggregate([
        { $match: { status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ])

    // Facturas open con más de 30 días = vencidas
    const overdueDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const overdue = await Invoice.countDocuments({
      status: 'open',
      createdAt: { $lt: overdueDate },
    })

    return {
      this_month: {
        revenue_cents:    thisMonthPaid[0]?.total ?? 0,
        invoices_paid:    thisMonthPaid[0]?.count ?? 0,
        invoices_open:    thisMonthOpen,
        invoices_overdue: overdue,
      },
      last_month: {
        revenue_cents: lastMonthPaid[0]?.total ?? 0,
        invoices_paid: lastMonthPaid[0]?.count ?? 0,
      },
      all_time: {
        total_revenue_cents: allTime[0]?.total ?? 0,
        total_invoices:      allTime[0]?.count ?? 0,
      },
    }
  })
}

module.exports = superAdminBillingRoutes
