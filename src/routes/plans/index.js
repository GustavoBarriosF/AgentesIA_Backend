'use strict'

const Plan            = require('../../db/models/plan')
const PlanDefinition  = require('../../db/models/plan-definition')
const Invoice         = require('../../db/models/invoice')
const Coupon          = require('../../db/models/coupon')
const Workspace       = require('../../db/models/workspace')
const Channel         = require('../../db/models/channel')
const WorkspaceMember = require('../../db/models/workspace-member')
const KnowledgeItem   = require('../../db/models/knowledge-item')
const BotAgent        = require('../../db/models/bot-agent')
const Conversation    = require('../../db/models/conversation')
const stripe          = require('../../services/stripe.service')
const logger          = require('../../utils/logger')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

const PlanObject = {
  type: 'object',
  properties: {
    _id:          { type: 'string' },
    workspace_id: { type: 'string' },
    tier:         { type: 'string', enum: ['free', 'starter', 'pro', 'enterprise'] },
    limits: {
      type: 'object',
      properties: {
        conversations_per_month: { type: 'integer' },
        agents:                  { type: 'integer' },
        channels:                { type: 'integer' },
        storage_gb:              { type: 'number' },
        knowledge_items:         { type: 'integer' },
        bots:                    { type: 'integer' },
      },
    },
    usage: {
      type: 'object',
      properties: {
        conversations_this_month: { type: 'integer' },
        agents:          { type: 'integer' },
        channels:        { type: 'integer' },
        knowledge_items: { type: 'integer' },
        bots:            { type: 'integer' },
        storage_gb:      { type: 'number' },
        period_start:    { type: 'string', format: 'date-time' },
      },
    },
    stripe_sub_id:     { type: 'string', nullable: true },
    stripe_cus_id:     { type: 'string', nullable: true },
    status:            { type: 'string' },
    trial_ends_at:     { type: 'string', format: 'date-time', nullable: true },
    trial_started_at:  { type: 'string', format: 'date-time', nullable: true },
    billing_cycle:     { type: 'string', nullable: true },
    next_billing_date: { type: 'string', format: 'date-time', nullable: true },
    coupon_applied:    { type: 'string', nullable: true },
    createdAt:         { type: 'string', format: 'date-time' },
    updatedAt:         { type: 'string', format: 'date-time' },
  },
}

async function planRoutes(fastify) {
  const preHandler = [fastify.authenticate, fastify.requireWorkspace]
  const adminHandler = [...preHandler, fastify.requireRole('admin')]

  // ─── GET /api/:workspaceId/plans ──────────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Plans'],
      summary: 'Obtener plan actual',
      description: 'Retorna el plan activo del workspace con límites y uso del mes en curso.',
      security,
      params: workspaceParam,
      response: {
        200: { description: 'Plan del workspace', ...PlanObject },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const workspaceId = request.workspaceId

    const now = new Date()
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)

    const [plan, agentCount, channelCount, knowledgeCount, botCount, conversationsThisMonth] =
      await Promise.all([
        Plan.findOne({ workspace_id: workspaceId }).lean(),
        WorkspaceMember.countDocuments({ workspace_id: workspaceId, active: true, role: { $in: ['owner', 'admin', 'agent'] } }),
        Channel.countDocuments({ workspace_id: workspaceId }),
        KnowledgeItem.countDocuments({ workspace_id: workspaceId }),
        BotAgent.countDocuments({ workspace_id: workspaceId }),
        Conversation.countDocuments({ workspace_id: workspaceId, createdAt: { $gte: startOfMonth } }),
      ])

    if (!plan) {
      return {
        tier: 'free',
        status: 'active',
        limits: { conversations_per_month: 100, agents: 2, channels: 1, storage_gb: 1, knowledge_items: 50, bots: 2 },
        usage: {
          conversations_this_month: conversationsThisMonth,
          agents: agentCount, channels: channelCount,
          knowledge_items: knowledgeCount, bots: botCount, storage_gb: 0,
        },
      }
    }

    // Actualizar contador almacenado si difiere del real (corrección silenciosa)
    if (plan.usage?.conversations_this_month !== conversationsThisMonth) {
      Plan.updateOne(
        { workspace_id: workspaceId },
        { $set: { 'usage.conversations_this_month': conversationsThisMonth, 'usage.period_start': startOfMonth } }
      ).catch(() => {})
    }

    return {
      ...plan,
      usage: {
        ...plan.usage,
        conversations_this_month: conversationsThisMonth,
        agents:          agentCount,
        channels:        channelCount,
        knowledge_items: knowledgeCount,
        bots:            botCount,
        storage_gb:      plan.usage?.storage_gb ?? 0,
      },
    }
  })

  // ─── GET /api/:workspaceId/plans/invoices ─────────────────────────────────
  fastify.get('/invoices', {
    preHandler: adminHandler,
    schema: {
      tags: ['Plans'],
      summary: 'Historial de facturas del workspace',
      description: 'Retorna las facturas almacenadas localmente. Si el workspace usa Stripe, también incluye las facturas de Stripe.',
      security,
      params: workspaceParam,
      response: {
        200: {
          type: 'object',
          properties: {
            invoices: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  _id:          { type: 'string' },
                  amount:       { type: 'integer' },
                  currency:     { type: 'string' },
                  status:       { type: 'string' },
                  tier:         { type: 'string' },
                  period_start: { type: 'string', format: 'date-time' },
                  period_end:   { type: 'string', format: 'date-time' },
                  invoice_url:  { type: 'string', nullable: true },
                  pdf_url:      { type: 'string', nullable: true },
                  paid_at:      { type: 'string', format: 'date-time', nullable: true },
                  createdAt:    { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const invoices = await Invoice.find({ workspace_id: request.workspaceId })
      .sort({ createdAt: -1 })
      .limit(24)
      .lean()
    return { invoices }
  })

  // ─── POST /api/:workspaceId/plans/checkout ────────────────────────────────
  fastify.post('/checkout', {
    preHandler: adminHandler,
    schema: {
      tags: ['Plans'],
      summary: 'Crear sesión de Stripe Checkout',
      description: 'Genera una URL de pago en Stripe para suscribirse a un plan. El workspace es redirigido al hosted checkout de Stripe.',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['tier', 'billing_cycle'],
        properties: {
          tier:          { type: 'string', enum: ['starter', 'pro', 'enterprise'] },
          billing_cycle: { type: 'string', enum: ['monthly', 'yearly'] },
          coupon:        { type: 'string', description: 'Código de cupón (opcional)' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            checkout_url: { type: 'string', description: 'URL de Stripe Checkout' },
            session_id:   { type: 'string' },
          },
        },
        400: { description: 'Plan no encontrado o inválido', ...errorResponse },
        503: { description: 'Stripe no configurado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    if (!process.env.STRIPE_SECRET_KEY) {
      return reply.code(503).send({ error: 'Integración Stripe no configurada' })
    }

    const { tier, billing_cycle, coupon: couponCode } = request.body
    const appUrl = process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:3001'

    // Obtener la PlanDefinition con el precio de Stripe
    const planDef = await PlanDefinition.findOne({ tier, active: true }).lean()
    if (!planDef) {
      return reply.code(400).send({ error: `Plan '${tier}' no encontrado o inactivo` })
    }

    const priceId = billing_cycle === 'yearly'
      ? planDef.stripe_price_id_yearly
      : planDef.stripe_price_id_monthly

    if (!priceId) {
      return reply.code(400).send({ error: `El plan '${tier}' no tiene precio de Stripe configurado` })
    }

    // Obtener o crear el Customer de Stripe
    let plan = await Plan.findOne({ workspace_id: request.workspaceId })
    let stripeCustomerId = plan?.stripe_cus_id

    if (!stripeCustomerId) {
      const workspace = await Workspace.findById(request.workspaceId).lean()
      const customer = await stripe.createCustomer({
        email: request.user.email,
        name: workspace?.name || request.workspaceId,
        workspaceId: request.workspaceId,
      })
      stripeCustomerId = customer.id
      if (plan) {
        await Plan.updateOne({ workspace_id: request.workspaceId }, { stripe_cus_id: stripeCustomerId })
      }
    }

    // Resolver cupón en Stripe si se proporcionó
    let stripeCouponId
    if (couponCode) {
      const dbCoupon = await Coupon.findOne({ code: couponCode.toUpperCase(), active: true }).lean()
      if (dbCoupon?.stripe_coupon_id) {
        stripeCouponId = dbCoupon.stripe_coupon_id
      }
    }

    const workspaceSlug = (await Workspace.findById(request.workspaceId).select('slug').lean())?.slug

    const session = await stripe.createCheckoutSession({
      customerId: stripeCustomerId,
      priceId,
      workspaceId: request.workspaceId,
      successUrl: `${appUrl}/${workspaceSlug}/settings?section=billing&checkout=success`,
      cancelUrl:  `${appUrl}/${workspaceSlug}/settings?section=billing&checkout=canceled`,
      couponId:   stripeCouponId,
    })

    return { checkout_url: session.url, session_id: session.id }
  })

  // ─── POST /api/:workspaceId/plans/portal ──────────────────────────────────
  fastify.post('/portal', {
    preHandler: adminHandler,
    schema: {
      tags: ['Plans'],
      summary: 'Crear sesión del Customer Portal de Stripe',
      description: 'Genera una URL del Stripe Customer Portal para gestionar la suscripción, métodos de pago y facturas.',
      security,
      params: workspaceParam,
      response: {
        200: {
          type: 'object',
          properties: {
            portal_url: { type: 'string', description: 'URL del Customer Portal de Stripe' },
          },
        },
        400: { description: 'Workspace sin suscripción Stripe', ...errorResponse },
        503: { description: 'Stripe no configurado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    if (!process.env.STRIPE_SECRET_KEY) {
      return reply.code(503).send({ error: 'Integración Stripe no configurada' })
    }

    const plan = await Plan.findOne({ workspace_id: request.workspaceId }).select('stripe_cus_id').lean()
    if (!plan?.stripe_cus_id) {
      return reply.code(400).send({ error: 'Este workspace no tiene una suscripción activa en Stripe' })
    }

    const appUrl = process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || 'http://localhost:3001'
    const workspaceSlug = (await Workspace.findById(request.workspaceId).select('slug').lean())?.slug

    const session = await stripe.createBillingPortalSession({
      customerId: plan.stripe_cus_id,
      returnUrl: `${appUrl}/${workspaceSlug}/settings?section=billing`,
    })

    return { portal_url: session.url }
  })

  // ─── POST /api/:workspaceId/plans/apply-coupon ────────────────────────────
  fastify.post('/apply-coupon', {
    preHandler: adminHandler,
    schema: {
      tags: ['Plans'],
      summary: 'Aplicar cupón de descuento',
      description: 'Valida y aplica un cupón al workspace. Devuelve error si el cupón no existe, expiró o ya alcanzó el máximo de usos.',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['code'],
        properties: {
          code: { type: 'string', description: 'Código del cupón (case-insensitive)' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            type:  { type: 'string', enum: ['percent', 'fixed_amount', 'free_trial_days'] },
            value: { type: 'number' },
            code:  { type: 'string' },
          },
        },
        400: { description: 'Cupón inválido', ...errorResponse },
        404: { description: 'Cupón no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { code } = request.body

    const coupon = await Coupon.findOne({ code: code.toUpperCase(), active: true }).lean()
    if (!coupon) {
      return reply.code(404).send({ error: 'Cupón no encontrado o inactivo' })
    }

    const now = new Date()
    if (coupon.valid_until && new Date(coupon.valid_until) < now) {
      return reply.code(400).send({ error: 'El cupón ha expirado' })
    }
    if (coupon.valid_from && new Date(coupon.valid_from) > now) {
      return reply.code(400).send({ error: 'El cupón aún no es válido' })
    }
    if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) {
      return reply.code(400).send({ error: 'El cupón ha alcanzado el máximo de usos' })
    }

    // Verificar que aplica al tier actual del workspace
    if (coupon.applies_to === 'specific_tiers') {
      const plan = await Plan.findOne({ workspace_id: request.workspaceId }).select('tier').lean()
      if (plan && !coupon.applicable_tiers.includes(plan.tier)) {
        return reply.code(400).send({
          error: `Este cupón solo aplica a los planes: ${coupon.applicable_tiers.join(', ')}`,
        })
      }
    }

    // Guardar el cupón aplicado en el plan
    await Plan.updateOne(
      { workspace_id: request.workspaceId },
      { coupon_applied: coupon.code }
    )

    // Incrementar contador de uso
    await Coupon.updateOne({ _id: coupon._id }, { $inc: { used_count: 1 } })

    return { type: coupon.type, value: coupon.value, code: coupon.code }
  })

  // ─── POST /api/:workspaceId/plans/stripe-webhook ──────────────────────────
  fastify.post('/stripe-webhook', {
    config: { rawBody: true },
    schema: {
      tags: ['Plans'],
      summary: 'Webhook de Stripe',
      description: [
        'Recibe eventos de Stripe para actualizar el plan del workspace.',
        '**No requiere autenticación JWT** — usa la firma `Stripe-Signature` del header.',
        '',
        'Eventos manejados:',
        '- `customer.subscription.updated` → actualiza tier y status',
        '- `customer.subscription.deleted` → cancela el plan',
        '- `invoice.payment_succeeded` → guarda factura y activa plan',
        '- `invoice.payment_failed` → cambia status a `past_due`',
      ].join('\n'),
      headers: {
        type: 'object',
        properties: {
          'stripe-signature': { type: 'string' },
        },
      },
      body: { type: 'object' },
      response: {
        200: { type: 'object', properties: { received: { type: 'boolean' } } },
        400: { description: 'Firma inválida', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const sig = request.headers['stripe-signature']
    const secret = process.env.STRIPE_WEBHOOK_SECRET

    // Verificar firma si está configurado
    let event
    if (secret && request.rawBody) {
      event = stripe.verifyWebhookSignature(request.rawBody.toString(), sig, secret)
      if (!event) {
        return reply.code(400).send({ error: 'Firma de webhook inválida' })
      }
    } else {
      event = request.body
    }

    try {
      await handleStripeEvent(event)
    } catch (err) {
      logger.error({ err, eventType: event?.type }, 'Error procesando webhook de Stripe')
    }

    return reply.code(200).send({ received: true })
  })
}

// ─── Stripe event handler ─────────────────────────────────────────────────────

async function handleStripeEvent(event) {
  if (!event?.type) return

  // Extraer metadata del workspace desde el objeto del evento
  function getWorkspaceId(obj) {
    return obj?.metadata?.workspace_id || obj?.subscription_details?.metadata?.workspace_id
  }

  switch (event.type) {
    case 'customer.subscription.updated': {
      const sub = event.data.object
      const workspaceId = getWorkspaceId(sub)
      if (!workspaceId) break

      const tier = sub.metadata?.tier || 'starter'
      const statusMap = { active: 'active', trialing: 'trialing', past_due: 'past_due', canceled: 'canceled' }
      const status = statusMap[sub.status] || sub.status

      await Plan.updateOne(
        { workspace_id: workspaceId },
        {
          tier,
          status,
          stripe_sub_id: sub.id,
          billing_cycle: sub.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly',
          next_billing_date: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
          trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
        }
      )
      logger.info({ workspaceId, tier, status }, 'Suscripción actualizada')
      break
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object
      const workspaceId = getWorkspaceId(sub)
      if (!workspaceId) break

      await Plan.updateOne(
        { workspace_id: workspaceId },
        { tier: 'free', status: 'canceled', stripe_sub_id: null, next_billing_date: null }
      )
      logger.info({ workspaceId }, 'Suscripción cancelada → degradado a free')
      break
    }

    case 'invoice.payment_succeeded': {
      const inv = event.data.object
      const workspaceId = inv.subscription_details?.metadata?.workspace_id
        || inv.metadata?.workspace_id
      if (!workspaceId) break

      const sub = inv.subscription

      // Guardar factura en nuestra base de datos
      await Invoice.findOneAndUpdate(
        { stripe_invoice_id: inv.id },
        {
          workspace_id:    workspaceId,
          stripe_invoice_id: inv.id,
          amount:          inv.amount_paid,
          currency:        inv.currency,
          status:          'paid',
          period_start:    new Date(inv.period_start * 1000),
          period_end:      new Date(inv.period_end * 1000),
          invoice_url:     inv.hosted_invoice_url || null,
          pdf_url:         inv.invoice_pdf || null,
          tier:            inv.metadata?.tier || 'starter',
          billing_cycle:   typeof sub === 'object'
            ? (sub.items?.data?.[0]?.price?.recurring?.interval === 'year' ? 'yearly' : 'monthly')
            : 'monthly',
          paid_at:         new Date(inv.status_transitions?.paid_at * 1000 || Date.now()),
        },
        { upsert: true, new: true }
      )

      // Activar el plan si estaba past_due
      await Plan.updateOne(
        { workspace_id: workspaceId, status: 'past_due' },
        { status: 'active' }
      )
      logger.info({ workspaceId, amount: inv.amount_paid }, 'Pago exitoso registrado')
      break
    }

    case 'invoice.payment_failed': {
      const inv = event.data.object
      const workspaceId = inv.subscription_details?.metadata?.workspace_id
        || inv.metadata?.workspace_id
      if (!workspaceId) break

      await Plan.updateOne({ workspace_id: workspaceId }, { status: 'past_due' })
      logger.warn({ workspaceId }, 'Pago fallido — plan marcado como past_due')
      break
    }

    default:
      // Evento no manejado — ignorar silenciosamente
      break
  }
}

module.exports = planRoutes
