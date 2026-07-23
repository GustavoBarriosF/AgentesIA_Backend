'use strict'

const fp = require('fastify-plugin')
const Plan            = require('../db/models/plan')
const Channel         = require('../db/models/channel')
const WorkspaceMember = require('../db/models/workspace-member')
const KnowledgeItem   = require('../db/models/knowledge-item')
const BotAgent        = require('../db/models/bot-agent')

const RESOURCE_LABEL = {
  conversation:   'conversaciones del mes',
  agent:          'agentes (miembros)',
  channel:        'canales',
  knowledge_item: 'ítems de conocimiento',
  bot:            'bots',
}

/**
 * Cuenta en vivo cuántos recursos tiene un workspace.
 * Para recursos estáticos (canales, agentes, etc.) siempre se hace
 * un COUNT real en lugar de depender de un contador almacenado.
 * Para conversaciones se usa el contador mensual del Plan.
 */
async function countUsed(workspaceId, resource, plan) {
  switch (resource) {
    case 'conversation':
      // Contador mensual almacenado en el plan (se incrementa al crear conversación)
      return plan.usage?.conversations_this_month ?? 0

    case 'agent':
      // Miembros activos (excluyendo 'viewer' que no consumen licencia)
      return WorkspaceMember.countDocuments({
        workspace_id: workspaceId,
        active: true,
        role: { $in: ['owner', 'admin', 'agent'] },
      })

    case 'channel':
      return Channel.countDocuments({ workspace_id: workspaceId })

    case 'knowledge_item':
      return KnowledgeItem.countDocuments({ workspace_id: workspaceId })

    case 'bot':
      return BotAgent.countDocuments({ workspace_id: workspaceId })

    default:
      return 0
  }
}

const LIMIT_FIELD = {
  conversation:   'conversations_per_month',
  agent:          'agents',
  channel:        'channels',
  knowledge_item: 'knowledge_items',
  bot:            'bots',
}

async function planEnforcementPlugin(fastify) {
  /**
   * Verifica que el workspace no haya excedido el límite del recurso dado.
   * Lanza un error 403 si el límite fue alcanzado.
   *
   * Recursos estáticos (channel, agent, knowledge_item, bot): COUNT en vivo.
   * Conversaciones: contador mensual almacenado en Plan.usage.
   *
   * Uso dentro de un handler:
   *   await fastify.checkLimit(workspaceId, 'agent')
   */
  fastify.decorate('checkLimit', async function (workspaceId, resource) {
    if (!workspaceId || !LIMIT_FIELD[resource]) return

    const plan = await Plan.findOne({ workspace_id: workspaceId })
      .select('limits usage status')
      .lean()

    if (!plan) return // sin plan → no bloquear (fallback seguro)

    // -1 significa ilimitado
    const limit = plan.limits?.[LIMIT_FIELD[resource]]
    if (limit === -1 || limit == null) return

    const used = await countUsed(workspaceId, resource, plan)

    if (used >= limit) {
      const err = new Error(
        `Has alcanzado el límite de ${limit} ${RESOURCE_LABEL[resource]} en tu plan actual.`
      )
      err.statusCode = 403
      err.code = 'plan_limit_reached'
      err.resource = resource
      err.limit = limit
      err.used = used
      throw err
    }
  })

  /**
   * Incrementa el contador de conversaciones del mes.
   * Llamar después de crear una conversación exitosamente.
   */
  fastify.decorate('incrementConversation', async function (workspaceId) {
    await Plan.updateOne(
      { workspace_id: workspaceId },
      { $inc: { 'usage.conversations_this_month': 1 } }
    )
  })
}

module.exports = fp(planEnforcementPlugin, { name: 'plan-enforcement' })
