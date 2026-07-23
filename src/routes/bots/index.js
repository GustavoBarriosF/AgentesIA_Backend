'use strict'

const BotAgent = require('../../db/models/bot-agent')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

// ── Esquemas reutilizables ────────────────────────────────────────────────────

const ActionSchema = {
  type: 'object',
  required: ['type'],
  properties: {
    type:                   { type: 'string', enum: ['next_step', 'goto_step', 'route_bot', 'route_agent', 'escalate_human', 'end', 'collect_name', 'collect_email', 'collect_phone', 'create_ticket', 'collect_text'] },
    goto_step_index:        { type: 'number', nullable: true },
    target_bot_id:          { type: 'string', nullable: true },
    target_agent_id:        { type: 'string', nullable: true },
    end_message:            { type: 'string', nullable: true },
    collect_message:        { type: 'string', nullable: true },
    collect_error_message:  { type: 'string', nullable: true },
    collect_key:            { type: 'string', nullable: true },
    // Para escalate_human: asignación directa a miembro o departamento
    assigned_member_id:     { type: 'string', nullable: true },
    assigned_department_id: { type: 'string', nullable: true },
    // Para create_ticket: configuración del ticket
    ticket_config: {
      type: 'object',
      nullable: true,
      additionalProperties: true,
    },
  },
}

const OptionSchema = {
  type: 'object',
  required: ['label', 'action'],
  properties: {
    label:  { type: 'string' },
    action: ActionSchema,
  },
}

const StepSchema = {
  type: 'object',
  required: ['message'],
  properties: {
    _id:     { type: 'string' },
    message: { type: 'string' },
    options: { type: 'array', items: OptionSchema },
    action:  { ...ActionSchema, nullable: true },
  },
}

const BotAgentObject = {
  type: 'object',
  properties: {
    _id:         { type: 'string' },
    workspace_id:{ type: 'string' },
    name:        { type: 'string' },
    avatar:      { type: 'string', nullable: true },
    type:        { type: 'string', enum: ['decision_bot', 'ai_agent'] },
    active:      { type: 'boolean' },
    // Decision bot
    steps: { type: 'array', items: StepSchema },
    // AI Agent
    system_prompt:              { type: 'string' },
    knowledge_item_ids:         { type: 'array', items: { type: 'string' } },
    provider:                   { type: 'string', nullable: true },
    model:                      { type: 'string', nullable: true },
    max_turns:                  { type: 'number' },
    rag_top_k:                  { type: 'number' },
    escalate_on_low_confidence: { type: 'boolean' },
    collect_name:           { type: 'boolean' },
    collect_phone:          { type: 'boolean' },
    collect_email:          { type: 'boolean' },
    collect_identification: { type: 'boolean' },
    default_department_id:  { type: 'string', nullable: true },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
}

async function botRoutes(fastify) {
  const preHandler  = [fastify.authenticate, fastify.requireWorkspace]
  const adminHandler = [...preHandler, fastify.requireRole('admin')]

  // ── GET /api/:workspaceId/bots ────────────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Bots'],
      summary: 'Listar bots y agentes de IA',
      security,
      params: workspaceParam,
      querystring: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['decision_bot', 'ai_agent'], description: 'Filtrar por tipo' },
        },
      },
      response: {
        200: { type: 'array', items: BotAgentObject },
        401: { ...errorResponse },
      },
    },
  }, async (request) => {
    const query = { workspace_id: request.workspaceId }
    if (request.query.type) query.type = request.query.type
    const bots = await BotAgent.find(query).sort({ createdAt: -1 }).lean()
    return bots.map(b => ({ ...b, default_department_id: b.default_department_id?.toString() ?? null }))
  })

  // ── GET /api/:workspaceId/bots/:botId ─────────────────────────────────────
  fastify.get('/:botId', {
    preHandler,
    schema: {
      tags: ['Bots'],
      summary: 'Obtener bot/agente por ID',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'botId'],
        properties: {
          workspaceId: { type: 'string' },
          botId:       { type: 'string' },
        },
      },
      response: {
        200: BotAgentObject,
        404: { ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const bot = await BotAgent.findOne({
      _id: request.params.botId,
      workspace_id: request.workspaceId,
    }).lean()
    if (!bot) return reply.code(404).send({ error: 'Bot no encontrado' })
    return { ...bot, default_department_id: bot.default_department_id?.toString() ?? null }
  })

  // ── POST /api/:workspaceId/bots ───────────────────────────────────────────
  fastify.post('/', {
    preHandler: adminHandler,
    schema: {
      tags: ['Bots'],
      summary: 'Crear bot o agente de IA',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name:   { type: 'string' },
          avatar: { type: 'string', nullable: true, description: 'base64 data URL' },
          type:   { type: 'string', enum: ['decision_bot', 'ai_agent'] },
          active: { type: 'boolean', default: true },
          // Decision bot
          steps: { type: 'array', items: StepSchema, default: [] },
          // AI Agent
          system_prompt:              { type: 'string', default: '' },
          knowledge_item_ids:         { type: 'array', items: { type: 'string' }, default: [] },
          provider:                   { anyOf: [{ type: 'string', enum: ['claude', 'openai', 'gemini', 'groq', 'ollama'] }, { type: 'null' }], default: null },
          model:                      { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
          max_turns:                  { type: 'number', default: 8 },
          rag_top_k:                  { type: 'number', default: 12 },
          escalate_on_low_confidence: { type: 'boolean', default: true },
        },
      },
      response: {
        201: BotAgentObject,
        403: { ...errorResponse },
      },
    },
  }, async (request, reply) => {
    await fastify.checkLimit(request.workspaceId, 'bot')
    const bot = await BotAgent.create({
      workspace_id: request.workspaceId,
      ...request.body,
    })
    return reply.code(201).send(bot.toObject())
  })

  // ── PATCH /api/:workspaceId/bots/:botId ───────────────────────────────────
  fastify.patch('/:botId', {
    preHandler: adminHandler,
    schema: {
      tags: ['Bots'],
      summary: 'Actualizar bot o agente de IA',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'botId'],
        properties: {
          workspaceId: { type: 'string' },
          botId:       { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name:   { type: 'string' },
          avatar: { type: 'string', nullable: true },
          active: { type: 'boolean' },
          steps:  { type: 'array', items: StepSchema },
          system_prompt:              { type: 'string' },
          knowledge_item_ids:         { type: 'array', items: { type: 'string' } },
          provider:                   { anyOf: [{ type: 'string', enum: ['claude', 'openai', 'gemini', 'groq', 'ollama'] }, { type: 'null' }] },
          model:                      { anyOf: [{ type: 'string' }, { type: 'null' }] },
          max_turns:                  { type: 'number' },
          rag_top_k:                  { type: 'number' },
          escalate_on_low_confidence: { type: 'boolean' },
          collect_name:           { type: 'boolean' },
          collect_phone:          { type: 'boolean' },
          collect_email:          { type: 'boolean' },
          collect_identification: { type: 'boolean' },
          default_department_id:  { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      response: {
        200: BotAgentObject,
        403: { ...errorResponse },
        404: { ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const updates = { ...request.body }

    // Normalizar: string vacío → null para evitar CastError de Mongoose
    // La validación de "departamento requerido para AI agents" se hace en el frontend
    if (updates.default_department_id === '') updates.default_department_id = null

    const bot = await BotAgent.findOneAndUpdate(
      { _id: request.params.botId, workspace_id: request.workspaceId },
      { $set: updates },
      { new: true }
    ).lean()
    if (!bot) return reply.code(404).send({ error: 'Bot no encontrado' })
    return { ...bot, default_department_id: bot.default_department_id?.toString() ?? null }
  })

  // ── DELETE /api/:workspaceId/bots/:botId ──────────────────────────────────
  fastify.delete('/:botId', {
    preHandler: adminHandler,
    schema: {
      tags: ['Bots'],
      summary: 'Eliminar bot o agente de IA',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'botId'],
        properties: {
          workspaceId: { type: 'string' },
          botId:       { type: 'string' },
        },
      },
      response: {
        204: { type: 'null' },
        403: { ...errorResponse },
        404: { ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const result = await BotAgent.findOneAndDelete({
      _id: request.params.botId,
      workspace_id: request.workspaceId,
    })
    if (!result) return reply.code(404).send({ error: 'Bot no encontrado' })
    return reply.code(204).send()
  })

  // ── POST /api/:workspaceId/bots/:botId/test ───────────────────────────────
  // Sandbox: prueba un ai_agent sin crear conversación real
  fastify.post('/:botId/test', {
    preHandler,
    schema: {
      tags: ['Bots'],
      summary: 'Probar agente de IA (sandbox)',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'botId'],
        properties: { workspaceId: { type: 'string' }, botId: { type: 'string' } },
      },
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string' },
          history: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                role:    { type: 'string', enum: ['user', 'assistant'] },
                content: { type: 'string' },
              },
            },
            default: [],
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            response:      { type: 'string' },
            should_escalate: { type: 'boolean' },
          },
        },
        404: { ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const bot = await BotAgent.findOne({
      _id: request.params.botId,
      workspace_id: request.workspaceId,
      type: 'ai_agent',
    }).lean()
    if (!bot) return reply.code(404).send({ error: 'Agente no encontrado' })

    const { callLLM }      = require('../../services/llm')
    const knowledgeService = require('../../services/knowledge.service')
    const Workspace        = require('../../db/models/workspace')

    const workspace    = await Workspace.findById(request.workspaceId).lean()
    const filterIds    = bot.knowledge_item_ids?.length ? bot.knowledge_item_ids : null
    const relevantItems = await knowledgeService.searchRelevant(request.workspaceId, request.body.message, { filterIds })
    const knowledgeContext = relevantItems.map(({ item }) => item.content).join('\n\n---\n\n')

    const workspaceName = workspace?.name || 'la empresa'
    let systemPrompt = (bot.system_prompt || '')
      .replace(/\{\{workspace_name\}\}/g, workspaceName)

    if (!systemPrompt) {
      systemPrompt = `Eres ${bot.name}, el asistente virtual de ${workspaceName}. Responde en español.`
    }
    if (knowledgeContext) {
      systemPrompt += `\n\n## Base de conocimiento:\n${knowledgeContext}`
    }

    const messages = [
      ...(request.body.history || []),
      { role: 'user', content: request.body.message },
    ]

    try {
      const result = await callLLM(messages, {
        workspaceId:  request.workspaceId,
        systemPrompt,
        provider:     bot.provider || undefined,
        model:        bot.model    || undefined,
        workspace,
      })
      const shouldEscalate = result.content.includes('[ESCALAR]') || result.content.includes('[BAJA_CONFIANZA]')
      return {
        response: result.content.replace('[ESCALAR]', '').replace('[BAJA_CONFIANZA]', '').trim(),
        should_escalate: shouldEscalate,
        provider: result.provider,
        model:    result.model,
      }
    } catch (err) {
      request.log.error({ err: err.message }, 'Error en test de agente')
      const status = err?.statusCode || err?.status || 500
      if (status === 401) return reply.code(400).send({ error: 'API key inválida. Verifica las credenciales en Configuración → Integraciones.' })
      if (status === 503) return reply.code(503).send({ error: err.message || 'Proveedor de IA no disponible.' })
      return reply.code(500).send({ error: `Error del proveedor de IA: ${err.message}` })
    }
  })
  // ── POST /api/:workspaceId/bots/:botId/preview-prompt ────────────────────
  // Vista previa del prompt compilado del agente IA
  fastify.post('/:botId/preview-prompt', {
    preHandler: adminHandler,
    schema: {
      tags: ['Bots'],
      summary: 'Vista previa del prompt del agente IA',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'botId'],
        properties: {
          workspaceId: { type: 'string' },
          botId:       { type: 'string' },
        },
      },
      body: {
        type: 'object',
        required: ['sample_message'],
        properties: {
          sample_message: { type: 'string', minLength: 1, description: 'Mensaje de prueba del usuario' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            section_identity:  { type: 'string' },
            section_context:   { type: 'string', nullable: true },
            section_rules:     { type: 'string' },
            full_prompt:       { type: 'string' },
            knowledge_titles:  { type: 'array', items: { type: 'string' } },
          },
        },
        400: { ...errorResponse },
        404: { ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { buildAgentSystemPrompt, SYSTEM_RULES } = require('../../services/bot.service')
    const knowledgeService = require('../../services/knowledge.service')
    const Workspace        = require('../../db/models/workspace')

    const { params, workspaceId } = request
    const { sample_message } = request.body

    // 1. Cargar el bot
    const bot = await BotAgent.findOne({ _id: params.botId, workspace_id: workspaceId }).lean()
    if (!bot) return reply.code(404).send({ error: 'Bot no encontrado' })

    // 2. Validar tipo
    if (bot.type !== 'ai_agent') {
      return reply.code(400).send({ error: 'El preview solo aplica para agentes de tipo ai_agent' })
    }

    // 3. Cargar workspace
    const workspace = await Workspace.findById(workspaceId).lean()

    // 4. Buscar knowledge relevante si corresponde (igual que handleAiTurn: contenido completo)
    let ragItems = []

    if (bot.knowledge_item_ids?.length && sample_message?.trim()) {
      try {
        ragItems = await knowledgeService.searchRelevant(
          workspaceId,
          sample_message,
          { filterIds: bot.knowledge_item_ids, topK: bot.rag_top_k ?? 8 }
        )
      } catch (err) {
        // Si el servicio de knowledge falla, continuar sin contexto
        ragItems = []
      }
    }

    // 5. Construir el contexto igual que handleAiTurn (título + contenido completo)
    const contextText = ragItems.length
      ? ragItems.map(r => `## ${r.item.title}\n\n${r.item.content}`).join('\n\n---\n\n')
      : ''

    // 6. Construir el prompt final usando modo estructurado
    const result = buildAgentSystemPrompt(bot, workspace, contextText, 1, false, true)
    const { section1, section2, section3, full_prompt } = result

    return {
      section_identity: section1,
      section_context:  section2,
      section_rules:    section3,
      full_prompt,
      knowledge_titles: ragItems.map(r => r.item.title),
    }
  })
}

module.exports = botRoutes
