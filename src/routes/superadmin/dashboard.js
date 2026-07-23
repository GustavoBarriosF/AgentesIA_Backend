'use strict'

const Workspace    = require('../../db/models/workspace')
const Plan         = require('../../db/models/plan')
const Conversation = require('../../db/models/conversation')
const Message      = require('../../db/models/message')
const Invoice      = require('../../db/models/invoice')

async function superAdminDashboardRoutes(fastify) {
  const preHandler = [fastify.authenticateSuperAdmin]

  // ─── GET /superadmin/stats ────────────────────────────────────────────────
  fastify.get('/stats', {
    preHandler,
    schema: {
      tags: ['SuperAdmin — Dashboard'],
      summary: 'Estadísticas globales de la plataforma',
      security: [{ BearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            workspaces: {
              type: 'object',
              properties: {
                total:     { type: 'integer' },
                active:    { type: 'integer' },
                suspended: { type: 'integer' },
                trialing:  { type: 'integer' },
                past_due:  { type: 'integer' },
                by_tier: {
                  type: 'object',
                  properties: {
                    free:       { type: 'integer' },
                    starter:    { type: 'integer' },
                    pro:        { type: 'integer' },
                    enterprise: { type: 'integer' },
                  },
                },
              },
            },
            revenue: {
              type: 'object',
              properties: {
                mrr: { type: 'number', description: 'Monthly Recurring Revenue en USD' },
                arr: { type: 'number', description: 'Annual Recurring Revenue en USD' },
                revenue_this_month: { type: 'number' },
                revenue_last_month: { type: 'number' },
              },
            },
            activity: {
              type: 'object',
              properties: {
                conversations_today:  { type: 'integer' },
                conversations_month:  { type: 'integer' },
                messages_today:       { type: 'integer' },
                new_workspaces_month: { type: 'integer' },
              },
            },
            top_workspaces: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  workspace_id: { type: 'string' },
                  name:         { type: 'string' },
                  slug:         { type: 'string' },
                  tier:         { type: 'string' },
                  conversations_this_month: { type: 'integer' },
                },
              },
            },
            revenue_chart: {
              type: 'array',
              description: 'Ingresos de los últimos 12 meses',
              items: {
                type: 'object',
                properties: {
                  month:   { type: 'string', description: 'YYYY-MM' },
                  revenue: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
  }, async () => {
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const endOfLastMonth   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)

    // ── Workspaces ─────────────────────────────────────────────────────────
    const [totalWorkspaces, plans] = await Promise.all([
      Workspace.countDocuments(),
      Plan.find().lean(),
    ])

    const byStatus = { active: 0, suspended: 0, trialing: 0, past_due: 0 }
    const byTier   = { free: 0, starter: 0, pro: 0, enterprise: 0 }

    for (const p of plans) {
      if (byStatus[p.status] !== undefined) byStatus[p.status]++
      if (byTier[p.tier] !== undefined) byTier[p.tier]++
    }

    // ── Revenue (desde invoices pagadas) ───────────────────────────────────
    const [invoicesThisMonth, invoicesLastMonth] = await Promise.all([
      Invoice.find({ status: 'paid', paid_at: { $gte: startOfMonth } }).lean(),
      Invoice.find({ status: 'paid', paid_at: { $gte: startOfLastMonth, $lte: endOfLastMonth } }).lean(),
    ])

    const revenueThisMonth = invoicesThisMonth.reduce((s, i) => s + i.amount, 0) / 100
    const revenueLastMonth = invoicesLastMonth.reduce((s, i) => s + i.amount, 0) / 100

    // MRR: sumar lo que pagan workspaces activos con suscripción
    // Aproximación: usar usage de planes (sin Stripe aún usamos revenue del mes)
    const mrr = revenueThisMonth || 0
    const arr = mrr * 12

    // ── Actividad ──────────────────────────────────────────────────────────
    const [conversationsToday, conversationsMonth, messagesToday, newWorkspacesMonth] = await Promise.all([
      Conversation.countDocuments({ createdAt: { $gte: startOfToday } }),
      Conversation.countDocuments({ createdAt: { $gte: startOfMonth } }),
      Message.countDocuments({ createdAt: { $gte: startOfToday } }),
      Workspace.countDocuments({ createdAt: { $gte: startOfMonth } }),
    ])

    // ── Top workspaces por uso ─────────────────────────────────────────────
    const topPlans = await Plan
      .find()
      .sort({ 'usage.conversations_this_month': -1 })
      .limit(10)
      .populate('workspace_id', 'name slug')
      .lean()

    const topWorkspaces = topPlans
      .filter(p => p.workspace_id)
      .map(p => ({
        workspace_id: p.workspace_id._id,
        name: p.workspace_id.name,
        slug: p.workspace_id.slug,
        tier: p.tier,
        conversations_this_month: p.usage?.conversations_this_month ?? 0,
      }))

    // ── Revenue chart (últimos 12 meses) ───────────────────────────────────
    const revenueChart = []
    for (let i = 11; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const monthEnd   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59)
      const label = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`

      const monthInvoices = await Invoice.find({
        status: 'paid',
        paid_at: { $gte: monthStart, $lte: monthEnd },
      }).lean()

      revenueChart.push({
        month: label,
        revenue: monthInvoices.reduce((s, inv) => s + inv.amount, 0) / 100,
      })
    }

    return {
      workspaces: {
        total:     totalWorkspaces,
        active:    byStatus.active,
        suspended: byStatus.suspended,
        trialing:  byStatus.trialing,
        past_due:  byStatus.past_due,
        by_tier:   byTier,
      },
      revenue: {
        mrr,
        arr,
        revenue_this_month: revenueThisMonth,
        revenue_last_month: revenueLastMonth,
      },
      activity: {
        conversations_today:  conversationsToday,
        conversations_month:  conversationsMonth,
        messages_today:       messagesToday,
        new_workspaces_month: newWorkspacesMonth,
      },
      top_workspaces: topWorkspaces,
      revenue_chart:  revenueChart,
    }
  })
}

module.exports = superAdminDashboardRoutes
