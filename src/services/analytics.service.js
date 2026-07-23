'use strict'

const mongoose = require('mongoose')
const Conversation = require('../db/models/conversation')
const Message = require('../db/models/message')
const { getRedis } = require('../db/redis')

const CACHE_TTL = 300 // 5 minutos

async function getOverview(workspaceId, { from, to } = {}) {
  const redis = getRedis()
  const cacheKey = `analytics:overview:${workspaceId}:${from}:${to}`
  const cached = await redis.get(cacheKey)
  if (cached) return JSON.parse(cached)

  const wsOid = mongoose.Types.ObjectId.createFromHexString(workspaceId)

  const dateFilter = {}
  if (from) dateFilter.$gte = new Date(from)
  if (to)   dateFilter.$lte = new Date(to)

  const baseMatch = { workspace_id: wsOid }
  if (Object.keys(dateFilter).length) baseMatch.createdAt = dateFilter

  const [
    statusAgg,
    channelAgg,
    slaAgg,
    botAgg,
    agentAgg,
    msgCount,
  ] = await Promise.all([
    // Conversaciones por estado
    Conversation.aggregate([
      { $match: baseMatch },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),

    // Conversaciones por canal (con nombre)
    Conversation.aggregate([
      { $match: baseMatch },
      {
        $lookup: {
          from: 'channels',
          localField: 'channel_id',
          foreignField: '_id',
          as: 'channel',
        },
      },
      { $unwind: '$channel' },
      {
        $group: {
          _id: '$channel._id',
          channel_name: { $first: '$channel.name' },
          type: { $first: '$channel.type' },
          count: { $sum: 1 },
        },
      },
    ]),

    // Tiempos promedio de respuesta y CSAT (solo resueltas)
    Conversation.aggregate([
      { $match: { ...baseMatch, status: 'resolved' } },
      {
        $group: {
          _id: null,
          avg_first_response_s: { $avg: '$first_response_time_s' },
          avg_resolution_s:     { $avg: '$resolution_time_s' },
          avg_csat:             { $avg: '$csat_score' },
        },
      },
    ]),

    // Tasa de escalación bot → agente
    Conversation.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: null,
          total:   { $sum: 1 },
          escalated: {
            $sum: {
              $cond: [{ $eq: ['$handled_by', 'agent'] }, 1, 0],
            },
          },
        },
      },
    ]),

    // Performance por agente
    Conversation.aggregate([
      { $match: { ...baseMatch, agent_id: { $exists: true, $ne: null } } },
      {
        $lookup: {
          from: 'agents',
          localField: 'agent_id',
          foreignField: '_id',
          as: 'agent',
        },
      },
      { $unwind: '$agent' },
      {
        $lookup: {
          from: 'users',
          localField: 'agent.user_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $group: {
          _id: '$agent._id',
          agent_name:       { $first: '$user.name' },
          conversations:    { $sum: 1 },
          avg_resolution_s: { $avg: '$resolution_time_s' },
          csat_avg:         { $avg: '$csat_score' },
        },
      },
    ]),

    // Total de mensajes en el período
    Message.countDocuments({ workspace_id: wsOid, ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}) }),
  ])

  // Normalizar by_status
  const byStatus = { open: 0, resolved: 0, abandoned: 0 }
  let totalConversations = 0
  for (const s of statusAgg) {
    const key = s._id
    if (key in byStatus) byStatus[key] = s.count
    totalConversations += s.count
  }

  // Normalizar by_channel
  const byChannel = channelAgg.map((ch) => ({
    channel_id:   ch._id.toString(),
    channel_name: ch.channel_name ?? 'Sin nombre',
    type:         ch.type ?? 'unknown',
    count:        ch.count,
  }))

  // SLA
  const sla = slaAgg[0] ?? {}

  // Escalación bot
  const botRow = botAgg[0] ?? { total: 0, escalated: 0 }
  const botEscalationRate = botRow.total > 0 ? botRow.escalated / botRow.total : 0

  // by_agent
  const byAgent = agentAgg.map((a) => ({
    agent_id:         a._id.toString(),
    agent_name:       a.agent_name ?? 'Agente',
    conversations:    a.conversations,
    avg_resolution_s: a.avg_resolution_s ?? 0,
    csat_avg:         a.csat_avg ?? 0,
  }))

  const result = {
    total_conversations:       totalConversations,
    by_status:                 byStatus,
    avg_first_response_time_s: sla.avg_first_response_s ?? 0,
    avg_resolution_time_s:     sla.avg_resolution_s ?? 0,
    avg_csat_score:            sla.avg_csat ?? 0,
    total_messages:            msgCount,
    bot_escalation_rate:       botEscalationRate,
    by_channel:                byChannel,
    by_agent:                  byAgent,
  }

  await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL)
  return result
}

async function getTokenUsage(workspaceId, { from, to } = {}) {
  const redis = getRedis()
  const cacheKey = `analytics:token-usage:${workspaceId}:${from}:${to}`
  const cached = await redis.get(cacheKey)
  if (cached) return JSON.parse(cached)

  const wsOid = mongoose.Types.ObjectId.createFromHexString(workspaceId)

  const dateFilter = {}
  if (from) dateFilter.$gte = new Date(from)
  if (to)   dateFilter.$lte = new Date(to)

  const baseMatch = {
    workspace_id: wsOid,
    'ai_meta.model': { $ne: null },
    'ai_meta.input_tokens': { $ne: null },
    ...(Object.keys(dateFilter).length ? { createdAt: dateFilter } : {}),
  }

  const [byModel, convAgg] = await Promise.all([
    // Tokens agrupados por modelo
    Message.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: '$ai_meta.model',
          input_tokens:     { $sum: '$ai_meta.input_tokens' },
          output_tokens:    { $sum: '$ai_meta.output_tokens' },
          message_count:    { $sum: 1 },
        },
      },
      { $sort: { input_tokens: -1 } },
    ]),

    // Promedio de tokens por conversación (conversaciones únicas con mensajes de IA)
    Message.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: '$conversation_id',
          conv_input:  { $sum: '$ai_meta.input_tokens' },
          conv_output: { $sum: '$ai_meta.output_tokens' },
        },
      },
      {
        $group: {
          _id: null,
          conversations:    { $sum: 1 },
          avg_input_conv:   { $avg: '$conv_input' },
          avg_output_conv:  { $avg: '$conv_output' },
          total_input:      { $sum: '$conv_input' },
          total_output:     { $sum: '$conv_output' },
        },
      },
    ]),
  ])

  const convRow = convAgg[0] ?? { conversations: 0, avg_input_conv: 0, avg_output_conv: 0, total_input: 0, total_output: 0 }

  const result = {
    total_input_tokens:            convRow.total_input,
    total_output_tokens:           convRow.total_output,
    total_tokens:                  convRow.total_input + convRow.total_output,
    conversations_with_ai:         convRow.conversations,
    avg_input_tokens_per_conv:     Math.round(convRow.avg_input_conv ?? 0),
    avg_output_tokens_per_conv:    Math.round(convRow.avg_output_conv ?? 0),
    avg_total_tokens_per_conv:     Math.round((convRow.avg_input_conv ?? 0) + (convRow.avg_output_conv ?? 0)),
    by_model: byModel.map(m => ({
      model:                m._id ?? 'desconocido',
      input_tokens:         m.input_tokens,
      output_tokens:        m.output_tokens,
      total_tokens:         m.input_tokens + m.output_tokens,
      message_count:        m.message_count,
      avg_input_per_msg:    Math.round(m.input_tokens / (m.message_count || 1)),
      avg_output_per_msg:   Math.round(m.output_tokens / (m.message_count || 1)),
    })),
  }

  await redis.set(cacheKey, JSON.stringify(result), 'EX', CACHE_TTL)
  return result
}

async function invalidateAnalyticsCache(workspaceId) {
  const redis = getRedis()
  const pattern = `analytics:overview:${workspaceId}:*`
  const keys = await redis.keys(pattern)
  if (keys.length > 0) {
    await redis.del(...keys)
  }
}

module.exports = { getOverview, getTokenUsage, invalidateAnalyticsCache }
