'use strict'

const Agent = require('../db/models/agent')
const Conversation = require('../db/models/conversation')
const { getRedis } = require('../db/redis')
const logger = require('../utils/logger')

async function listAgents(workspaceId) {
  const redis = getRedis()
  const agents = await Agent.find({ workspace_id: workspaceId })
    .populate('user_id', 'name email avatar_url')
    .lean()

  // Enriquecer con el estado real desde Redis (más fresco que MongoDB)
  const enriched = await Promise.all(agents.map(async (agent) => {
    const redisStatus = await redis.get(`agent:status:${workspaceId}:${agent._id}`)
    return { ...agent, status: redisStatus || agent.status }
  }))

  return enriched
}

async function getAgent(workspaceId, agentId) {
  const agent = await Agent.findOne({ _id: agentId, workspace_id: workspaceId })
    .populate('user_id', 'name email avatar_url')
    .lean()
  if (!agent) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 })
  return agent
}

async function updateAgent(workspaceId, agentId, data) {
  const allowed = ['skills', 'max_chats']
  const update = {}
  for (const key of allowed) {
    if (data[key] !== undefined) update[key] = data[key]
  }
  const agent = await Agent.findOneAndUpdate(
    { _id: agentId, workspace_id: workspaceId },
    { $set: update },
    { new: true }
  )
  if (!agent) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 })
  return agent
}

async function setAgentStatus(workspaceId, agentId, status) {
  const redis = getRedis()
  const agent = await Agent.findOneAndUpdate(
    { _id: agentId, workspace_id: workspaceId },
    { $set: { status } },
    { new: true }
  )
  if (!agent) throw Object.assign(new Error('Agente no encontrado'), { statusCode: 404 })

  if (status === 'online') {
    await redis.set(`agent:status:${workspaceId}:${agentId}`, 'online', 'EX', 30)
    await redis.sadd(`agents:online:${String(workspaceId)}`, String(agentId))
    // Bug 2+3: EXPIRE en el Set (35s > 30s de status, minimiza ventana de inconsistencia)
    await redis.expire(`agents:online:${String(workspaceId)}`, 35)
    // Bug 1: guardar ws_info bajo userId (sub del JWT) para que disconnect lo encuentre
    const userId = String(agent.user_id?._id ?? agent.user_id)
    await redis.set(`agent:ws_info:${userId}`, JSON.stringify({ workspaceId: String(workspaceId), agentId: String(agentId) }), 'EX', 35)
  } else {
    await redis.del(`agent:status:${workspaceId}:${agentId}`)
    await redis.srem(`agents:online:${String(workspaceId)}`, String(agentId))
  }

  // Si pasa a online, procesar la cola
  if (status === 'online') {
    processQueue(workspaceId).catch(err => logger.error({ err }, 'Error procesando cola'))
  }

  return agent
}

/**
 * Asigna una conversacion al mejor agente disponible.
 * Retorna el agente asignado o null si no hay disponibles.
 */
async function assignConversation(workspaceId, conversationId, tags = []) {
  const redis = getRedis()

  // Lock para evitar condicion de carrera
  const lockKey = `conversation:lock:${conversationId}`
  const locked = await redis.set(lockKey, '1', 'NX', 'EX', 300)
  if (!locked) return null

  try {
    // Buscar agentes online del workspace
    const agents = await Agent.find({
      workspace_id: workspaceId,
      active: true,
    }).lean()

    const availableAgents = []
    for (const agent of agents) {
      const statusKey = `agent:status:${workspaceId}:${agent._id}`
      const status = await redis.get(statusKey)
      if (status !== 'online') continue

      const activeChatsKey = `agent:active_chats:${workspaceId}:${agent._id}`
      const activeChats = parseInt(await redis.get(activeChatsKey) || '0')
      if (activeChats >= agent.max_chats) continue

      availableAgents.push({ ...agent, activeChats })
    }

    if (availableAgents.length === 0) return null

    // Ordenar por: skills matching > menor carga
    let best = availableAgents.sort((a, b) => {
      const aSkills = tags.filter(t => a.skills.includes(t)).length
      const bSkills = tags.filter(t => b.skills.includes(t)).length
      if (bSkills !== aSkills) return bSkills - aSkills
      return a.activeChats - b.activeChats
    })[0]

    // Asignar conversacion
    await Conversation.findByIdAndUpdate(conversationId, {
      $set: { agent_id: best._id, status: 'assigned' },
    })

    // Incrementar contador en Redis
    const activeChatsKey = `agent:active_chats:${workspaceId}:${best._id}`
    await redis.incr(activeChatsKey)
    await redis.expire(activeChatsKey, 30)

    // Actualizar MongoDB
    await Agent.findByIdAndUpdate(best._id, { $inc: { active_chats: 1 } })

    return best
  } finally {
    await redis.del(lockKey)
  }
}

/**
 * Decrementa el contador de chats activos cuando se resuelve una conversacion
 */
async function decrementAgentChats(workspaceId, agentId) {
  const redis = getRedis()
  const key = `agent:active_chats:${workspaceId}:${agentId}`
  const val = await redis.decr(key)
  if (val < 0) await redis.set(key, '0')
  await Agent.findByIdAndUpdate(agentId, { $inc: { active_chats: -1 } })
}

/**
 * Procesa la cola de conversaciones pendientes asignando a agentes disponibles
 */
async function processQueue(workspaceId) {
  const redis = getRedis()
  const queueKey = `queue:${workspaceId}`

  let convId
  while ((convId = await redis.lpop(queueKey))) {
    const conv = await Conversation.findById(convId).lean()
    if (!conv || conv.status !== 'pending') continue

    const assigned = await assignConversation(workspaceId, convId, conv.tags || [])
    if (!assigned) {
      // No hay agentes disponibles, devolver a la cola
      await redis.lpush(queueKey, convId)
      break
    }

    logger.info({ convId, agentId: assigned._id }, 'Conversacion asignada desde cola')
  }
}

module.exports = { listAgents, getAgent, updateAgent, setAgentStatus, assignConversation, decrementAgentChats, processQueue }
