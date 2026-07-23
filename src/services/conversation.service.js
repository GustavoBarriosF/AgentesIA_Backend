'use strict'

const Conversation = require('../db/models/conversation')
const Contact = require('../db/models/contact')
const Message = require('../db/models/message')
const Plan = require('../db/models/plan')
const agentService = require('./agent.service')
const { getRedis } = require('../db/redis')
const { invalidateAnalyticsCache } = require('./analytics.service')

async function listConversations(workspaceId, { status, active_only, agent_id, channel_id, from, to, cursor, limit = 20, apply_visibility = false, visible_to_agent_id, visible_to_dept_id, dept_unassigned_only = false } = {}) {
  const query = { workspace_id: workspaceId }
  if (status) {
    query.status = status
  } else if (active_only) {
    query.status = { $nin: ['resolved', 'abandoned'] }
  }
  if (agent_id) query.agent_id = agent_id
  if (channel_id) query.channel_id = channel_id
  if (from || to) {
    query.createdAt = {}
    if (from) query.createdAt.$gte = new Date(from)
    if (to) query.createdAt.$lte = new Date(to)
  }
  if (cursor) query._id = { $lt: cursor }

  if (apply_visibility) {
    const conditions = []
    // Conversaciones asignadas directamente al agente (agent/viewer)
    if (visible_to_agent_id) conditions.push({ agent_id: visible_to_agent_id })
    if (visible_to_dept_id) {
      if (dept_unassigned_only) {
        // agent/viewer: solo conversaciones de su depto sin agente asignado
        conditions.push({ department_id: visible_to_dept_id, agent_id: null })
      } else {
        // admin con depto: ve todas las conversaciones de su departamento
        conditions.push({ department_id: visible_to_dept_id })
      }
    }
    query.$or = conditions.length > 0 ? conditions : [{ _id: null }]
  }

  const numLimit = Number(limit)
  const conversations = await Conversation.find(query)
    .sort({ last_message_at: -1 })
    .limit(numLimit)
    .populate('contact_id', 'name email phone avatar_url')
    .populate('agent_id', 'user_id')
    .lean()

  const next_cursor = conversations.length === numLimit
    ? conversations[conversations.length - 1]._id.toString()
    : null

  return { conversations, next_cursor, total: conversations.length }
}

async function getConversation(workspaceId, convId) {
  const conv = await Conversation.findOne({ _id: convId, workspace_id: workspaceId })
    .populate('contact_id')
    .populate({ path: 'agent_id', populate: { path: 'user_id', select: 'name email avatar_url' } })
    .lean()
  if (!conv) throw Object.assign(new Error('Conversacion no encontrada'), { statusCode: 404 })
  return conv
}

async function createConversation(workspaceId, { contactId, channelId, metadata }) {
  // Verificar limite del plan
  const plan = await Plan.findOne({ workspace_id: workspaceId })
  if (plan && plan.usage.conversations_this_month >= plan.limits.conversations_per_month) {
    throw Object.assign(new Error('Limite de conversaciones del plan alcanzado'), { statusCode: 402 })
  }

  const conv = await Conversation.create({
    workspace_id: workspaceId,
    contact_id: contactId,
    channel_id: channelId,
    status: 'open',
    metadata: metadata || {},
  })

  // Incrementar uso del plan
  if (plan) {
    await Plan.findByIdAndUpdate(plan._id, { $inc: { 'usage.conversations_this_month': 1 } })
  }

  // Incrementar contador del contacto
  await Contact.findByIdAndUpdate(contactId, { $inc: { conversation_count: 1 } })

  await invalidateAnalyticsCache(workspaceId)
  return conv
}

async function assignConversation(workspaceId, convId, agentId) {
  const conv = await Conversation.findOneAndUpdate(
    { _id: convId, workspace_id: workspaceId },
    { $set: { agent_id: agentId, status: 'assigned' } },
    { new: true }
  )
  if (!conv) throw Object.assign(new Error('Conversacion no encontrada'), { statusCode: 404 })
  return conv
}

async function resolveConversation(workspaceId, convId) {
  const conv = await Conversation.findOne({ _id: convId, workspace_id: workspaceId })
  if (!conv) throw Object.assign(new Error('Conversacion no encontrada'), { statusCode: 404 })

  const resolutionTime = Math.floor((Date.now() - conv.createdAt.getTime()) / 1000)
  conv.status = 'resolved'
  conv.resolved_at = new Date()
  conv.resolution_time_s = resolutionTime
  await conv.save()

  if (conv.agent_id) {
    await agentService.decrementAgentChats(workspaceId, conv.agent_id.toString())
  }

  await invalidateAnalyticsCache(workspaceId)
  return conv
}

async function reopenConversation(workspaceId, convId) {
  const conv = await Conversation.findOneAndUpdate(
    { _id: convId, workspace_id: workspaceId, status: { $in: ['resolved', 'abandoned'] } },
    { $set: { status: 'open', resolved_at: null, resolution_time_s: null } },
    { new: true }
  )
  if (!conv) throw Object.assign(new Error('Conversacion no encontrada o no se puede reabrir'), { statusCode: 404 })
  await invalidateAnalyticsCache(workspaceId)
  return conv
}

async function transferConversation(workspaceId, convId, toAgentId) {
  const conv = await Conversation.findOne({ _id: convId, workspace_id: workspaceId })
  if (!conv) throw Object.assign(new Error('Conversacion no encontrada'), { statusCode: 404 })

  const prevAgentId = conv.agent_id

  conv.agent_id = toAgentId
  conv.status = 'assigned'
  await conv.save()

  if (prevAgentId) {
    await agentService.decrementAgentChats(workspaceId, prevAgentId.toString())
  }
  // Incrementar contador del nuevo agente
  const redis = getRedis()
  await redis.incr(`agent:active_chats:${workspaceId}:${toAgentId}`)

  return conv
}

async function saveCsat(workspaceId, convId, { score, comment }) {
  const conv = await Conversation.findOneAndUpdate(
    { _id: convId, workspace_id: workspaceId },
    { $set: { csat_score: score, csat_comment: comment || null } },
    { new: true }
  )
  if (!conv) throw Object.assign(new Error('Conversacion no encontrada'), { statusCode: 404 })
  return conv
}

async function escalateToQueue(workspaceId, convId, { assignedMemberId, assignedDepartmentId } = {}) {
  const redis = getRedis()

  if (assignedMemberId) {
    // Buscar el perfil Agent del usuario asignado y asignar directamente
    const Agent = require('../db/models/agent')
    const agent = await Agent.findOne({ workspace_id: workspaceId, user_id: assignedMemberId }).lean()
    if (agent) {
      await Conversation.findByIdAndUpdate(convId, {
        $set: {
          status:        'assigned',
          agent_id:      agent._id,
          department_id: assignedDepartmentId || null,
        },
      })
      return
    }
  }

  await Conversation.findByIdAndUpdate(convId, {
    $set: {
      status:        'pending',
      agent_id:      null,
      department_id: assignedDepartmentId || null,
    },
  })
  await redis.rpush(`queue:${workspaceId}`, convId.toString())
  // Intentar asignar de inmediato
  await agentService.processQueue(workspaceId)
}

async function escalateConversation(conversationId, workspaceId, io) {
  const conv = await Conversation.findByIdAndUpdate(
    conversationId,
    { $set: { status: 'open', handled_by: 'agent' } },
    { new: true }
  ).lean()
  if (io && conv) {
    io.to(`ws:${workspaceId}`).emit('conversation:status_changed', {
      conversationId,
      status: 'open',
    })
  }
  await invalidateAnalyticsCache(workspaceId)
  return conv
}

async function deleteConversation(workspaceId, convId) {
  const conv = await Conversation.findOne({ _id: convId, workspace_id: workspaceId })
  if (!conv) throw Object.assign(new Error('Conversacion no encontrada'), { statusCode: 404 })

  // Liberar slot del agente si está asignada
  if (conv.agent_id && conv.status === 'assigned') {
    await agentService.decrementAgentChats(workspaceId, conv.agent_id.toString())
  }

  await Message.deleteMany({ conversation_id: convId })
  await Conversation.findByIdAndDelete(convId)
}

module.exports = {
  listConversations, getConversation, createConversation,
  assignConversation, resolveConversation, reopenConversation,
  transferConversation, saveCsat, escalateToQueue, escalateConversation,
  deleteConversation,
}
