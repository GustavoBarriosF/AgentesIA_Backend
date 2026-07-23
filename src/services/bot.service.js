'use strict'

/**
 * bot.service.js
 *
 * Motor de bots multi-agente. Soporta dos tipos de BotAgent:
 *
 *   decision_bot  → árbol de pasos con opciones. El usuario elige una opción
 *                   que dispara una acción (siguiente paso, routing, escalar, finalizar).
 *
 *   ai_agent      → agente LLM (Claude / Ollama / …) con system_prompt y base de conocimiento propia.
 *                   El proveedor/modelo se resuelve vía callLLM → AIProvider del workspace.
 *                   Escala cuando no tiene respuesta o supera max_turns.
 *
 * Flujo de una conversación:
 *   1. startBotFlow()  → llamado al crear la conversación nueva.
 *                        Busca el entry_bot_id del workspace y envía el primer mensaje.
 *   2. handleMessage() → llamado por cada mensaje del contacto mientras status = 'bot'.
 *                        Delega a handleDecisionStep() o handleAiTurn() según el bot activo.
 */

const { callLLM }           = require('./llm')
const { generateUniqueCode } = require('../utils/helpers')
const protocolService        = require('./protocol.service')
const KnowledgeItem          = require('../db/models/knowledge-item')
const PaymentLink            = require('../db/models/payment-link')
const Product                = require('../db/models/product')
const Lead                   = require('../db/models/lead')
const BotAgent         = require('../db/models/bot-agent')
const Conversation     = require('../db/models/conversation')
const Contact          = require('../db/models/contact')
const Workspace        = require('../db/models/workspace')
const Channel          = require('../db/models/channel')
const Message          = require('../db/models/message')
const Ticket           = require('../db/models/ticket')
const Department       = require('../db/models/department')
const msgService       = require('./message.service')
const knowledgeService = require('./knowledge.service')
const { getProtocolChunks } = require('./rag.service')
const mailer           = require('./mailer.service')
const channelService   = require('./channel.service')
const { invalidateAnalyticsCache } = require('./analytics.service')
const erpService       = require('./erp.service')
const logger           = require('../utils/logger')
const { getBotMessage } = require('./i18n.service')

// ─── Interpolación de variables en mensajes ───────────────────────────────────
// Sustituye {{clave}} por el valor correspondiente del mapa de variables.
// Las claves no encontradas se dejan como {{clave}} para evitar romper el texto.
function interpolateMessage(text, vars = {}) {
  if (!text) return text
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key]
    return val != null && val !== '' ? String(val) : `{{${key}}}`
  })
}

// ─── Señales de acción ────────────────────────────────────────────────────────
// El LLM las emite en su respuesta cuando el documento (base de conocimiento)
// lo indica explícitamente en ese punto del protocolo.
// Todas son case-insensitive y van entre corchetes.
//
//  [cerrar]              → cierra la conversación como resuelta
//  [escalar]             → transfiere a cualquier agente humano disponible
//  [escalar:Soporte]     → transfiere al departamento indicado
//  [ticket:Soporte]      → crea ticket para el departamento indicado
//  [lead]                → registra un lead de venta en el CRM
//  [baja_confianza]      → indica que la respuesta tiene poca certeza (opcional)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Señales de acción ────────────────────────────────────────────────────────
// Tolerantes a espacios dentro de los corchetes: [ ticket:Soporte ] == [ticket:Soporte]
// Case-insensitive. El LLM las emite cuando el documento las incluye en el protocolo.
//
//  [cerrar]              → cierra la conversación como resuelta
//  [escalar]             → transfiere a cualquier agente humano disponible
//  [escalar:Soporte]     → transfiere al departamento indicado
//  [ticket:Soporte]      → crea ticket para el departamento indicado
//  [lead]                → registra un lead de venta en el CRM
//  [baja_confianza]      → respuesta con poca certeza (escalamiento opcional)
// ─────────────────────────────────────────────────────────────────────────────

// Regex tolerantes a espacios opcionales dentro de los corchetes
const RE_CLOSE         = /\[\s*cerrar\s*\]/i
const RE_LOW_CONF      = /\[\s*baja_confianza\s*\]/i
const RE_LEAD          = /\[\s*lead\s*\]/i
const RE_ESCALATE      = /\[\s*escalar\s*(?::\s*([^\]]+?)\s*)?\]/i
const RE_TICKET        = /\[\s*ticket\s*:\s*([^\]]+?)\s*\]/i
// Aliases heredados de versiones anteriores del código
const RE_LEGACY_ESC    = /\[ESCALAR\]/
const RE_LEGACY_TICKET = /\[CREAR_TICKET:\s*([^\]]+?)\s*\]/i

/** Parsea todas las señales presentes en el texto del LLM */
function parseSignals(text) {
  // Normalizar aliases heredados
  const normalized = text
    .replace(RE_LEGACY_ESC, '[escalar]')
    .replace(RE_LEGACY_TICKET, (_, dept) => `[ticket:${dept}]`)

  const escalationMatch = normalized.match(RE_ESCALATE)
  const ticketMatch     = normalized.match(RE_TICKET)

  return {
    shouldClose:    RE_CLOSE.test(normalized),
    lowConfidence:  RE_LOW_CONF.test(normalized),
    shouldLead:     RE_LEAD.test(normalized),
    shouldEscalate: !!escalationMatch,
    escalateDept:   escalationMatch ? (escalationMatch[1]?.trim() || null) : null,
    ticketDept:     ticketMatch ? ticketMatch[1].trim() : null,
    normalized,
  }
}

/** Elimina todas las señales del texto para enviarlo limpio al cliente */
function stripSignals(text) {
  return text
    .replace(RE_LEGACY_ESC, '')
    .replace(RE_LEGACY_TICKET, '')
    .replace(RE_ESCALATE, '')
    .replace(RE_TICKET, '')
    .replace(RE_CLOSE, '')
    .replace(RE_LOW_CONF, '')
    .replace(RE_LEAD, '')
    .trim()
}

// Devuelve los campos de registro faltantes según la configuración del bot.
// Solo incluye un campo si el bot tiene habilitada su recopilación Y el contacto no lo tiene.
function getMissingRegistrationFields(contact, bot = {}) {
  const missing = []
  if (bot.collect_name && (!contact?.name || contact.name === 'Visitante'))
    missing.push({ field: 'name', label: 'nombre completo' })
  if (bot.collect_phone && !contact?.phone)
    missing.push({ field: 'phone', label: 'número de teléfono (para contactarte si se interrumpe la conversación)' })
  if (bot.collect_email && !contact?.email)
    missing.push({ field: 'email', label: 'correo electrónico (para enviarte información de tu caso)' })
  if (bot.collect_identification && !contact?.custom_fields?.cedula)
    missing.push({ field: 'cedula', label: 'número de cédula o número de cliente (para verificar tu identidad y acceder a tu cuenta)' })
  return missing
}

// System prompt minimalista solo para la fase de registro.
// No incluye KB ni reglas de negocio; el LLM solo debe pedir el siguiente dato.
function buildRegistrationSystemPrompt(bot, workspace, missingFields, hasExistingBotMessages) {
  const workspaceName = workspace?.name || 'la empresa'
  const botName = bot.name || 'Asistente'
  const customPrompt = (bot.system_prompt || '').replace(/\{\{workspace_name\}\}/g, workspaceName)
  const persona = customPrompt || `Eres ${botName}, asistente virtual de ${workspaceName}. Eres amable y natural. Respondes en español.`

  const ongoingInstruction = hasExistingBotMessages
    ? `\n\nEsta conversación ya está en curso. NO te presentes de nuevo ni repitas el saludo.`
    : ''

  const nextField = missingFields[0]
  const pendingList = missingFields.map((f, i) => `${i + 1}. ${f.label}`).join('\n')

  return persona + ongoingInstruction + `\n\n` +
    `TAREA OBLIGATORIA: Antes de atender cualquier solicitud técnica o de servicio, debes recopilar los datos de registro del cliente.\n\n` +
    `Datos pendientes (en orden):\n${pendingList}\n\n` +
    `En este turno, pide ÚNICAMENTE el siguiente dato: **${nextField.label}**.\n` +
    `Reglas:\n` +
    `- Si el cliente acaba de proporcionar este dato en su último mensaje, agradece brevemente y pide el siguiente dato de la lista.\n` +
    `- Si el cliente pregunta por qué lo necesitas, explícale brevemente y luego vuelve a pedirlo.\n` +
    `- NO respondas sobre el problema técnico todavía. NO des información de servicios. NO hagas más de una pregunta.\n` +
    `- Respuesta corta y amigable, máximo 2 oraciones.`
}

// Extrae datos de registro (nombre, teléfono, email, cédula) del historial de mensajes
// y los guarda en el contacto. Se llama al final de cada turno del agente IA.
async function extractAndSaveContactData(contactId, history) {
  const contact = await Contact.findById(contactId).select('name phone email custom_fields').lean()
  if (!contact) return

  const updates = {}
  const userMessages = history.filter(m => m.sender_type === 'contact')

  // Teléfono: móvil colombiano (10 dígitos comenzando con 3)
  if (!contact.phone) {
    for (const msg of userMessages) {
      const m = msg.content.match(/\b(3\d{9})\b/)
      if (m) { updates.phone = m[1]; break }
    }
  }

  // Email
  if (!contact.email) {
    for (const msg of userMessages) {
      const m = msg.content.match(/\b[\w.+\-]+@[\w\-]+\.[a-z]{2,10}\b/i)
      if (m) { updates.email = m[0].toLowerCase(); break }
    }
  }

  // Nombre: respuesta del usuario inmediatamente después de que el bot preguntó por el nombre
  if (!contact.name || contact.name === 'Visitante') {
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1]
      const curr = history[i]
      if (prev.sender_type === 'bot' && curr.sender_type === 'contact') {
        const prevLower = prev.content.toLowerCase()
        if (prevLower.includes('nombre') || prevLower.includes('llamas') || prevLower.includes('presentas')) {
          const name = curr.content.trim()
          if (name.length >= 2 && name.length <= 60 && !/^\d+$/.test(name) && !name.includes('@')) {
            updates.name = name.replace(/\b\w/g, c => c.toUpperCase())
            break
          }
        }
      }
    }
  }

  // Cédula: respuesta del usuario después de que el bot preguntó por cédula/documento/identificación
  if (!contact.custom_fields?.cedula) {
    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1]
      const curr = history[i]
      if (prev.sender_type === 'bot' && curr.sender_type === 'contact') {
        const prevLower = prev.content.toLowerCase()
        if (prevLower.includes('cédula') || prevLower.includes('cedula') || prevLower.includes('documento') || prevLower.includes('identidad') || prevLower.includes('número de cliente') || prevLower.includes('numero de cliente')) {
          const val = curr.content.replace(/\s/g, '')
          if (/^\d{6,12}$/.test(val)) {
            updates.custom_fields = { ...(contact.custom_fields || {}), cedula: val }
            break
          }
        }
      }
    }
  }

  if (Object.keys(updates).length > 0) {
    await Contact.findByIdAndUpdate(contactId, { $set: updates })
    logger.info({ contactId: contactId.toString(), fields: Object.keys(updates) }, '[Bot] Datos de registro guardados en contacto')
  }
}

const TICKET_STATUS_PATTERNS = [
  /\b(cómo|como)\s+(va|está|esta|sigue)\s+(mi\s+)?(caso|ticket|solicitud|reporte|queja|reclamo)\b/i,
  /\b(estado|estatus|seguimiento)\s+(de\s+)?(mi\s+)?(caso|ticket|solicitud)\b/i,
  /\b(mi\s+)?(número|numero)\s+(de\s+)?(caso|ticket|solicitud|radicado)\b/i,
  /\b(consultar?|revisar?|verificar?)\s+(mi\s+)?(caso|ticket|solicitud)\b/i,
  /\b(ya\s+)?(resolvieron?|solucionaron?|atendieron?)\s+(mi\s+)?(caso|ticket|solicitud)\b/i,
  /\bticket\s+#?\w+\b/i,
]

// Palabras que el usuario puede escribir para pedir un agente humano
const HUMAN_KEYWORDS = [
  'agente', 'persona', 'humano', 'hablar con alguien',
  'asesor', 'representante', 'operador',
]

// ─────────────────────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inicia el flujo de bot al crear una conversación nueva.
 * Retorna { handled: boolean }
 */
async function startBotFlow({ workspaceId, conversation, io }) {
  const workspace = await Workspace.findById(workspaceId).lean()
  if (!workspace?.settings?.bot_enabled) return { handled: false }

  const entryBotId = workspace.settings?.entry_bot_id
  if (!entryBotId) return { handled: false }

  const bot = await BotAgent.findOne({
    _id: entryBotId,
    workspace_id: workspaceId,
    active: true,
  }).lean()
  if (!bot) return { handled: false }

  // Marcar la conversación con el bot activo y cambiar estado a 'bot'
  await Conversation.findByIdAndUpdate(conversation._id, {
    status: 'bot',
    handled_by: 'bot',
    current_bot_id: bot._id,
    current_step_index: 0,
    current_agent_turns: 0,
    visited_bot_ids: [bot._id],
  })
  conversation.current_bot_id = bot._id
  conversation.current_step_index = 0
  conversation.status = 'bot'
  conversation.visited_bot_ids = [bot._id]

  if (bot.type === 'decision_bot') {
    const stepResult = await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: 0, io })
    if (stepResult?.shouldEscalate) return { handled: true, ...stepResult }
  } else {
    const welcome = extractWelcome(bot.system_prompt) ||
      `Hola, soy ${bot.name}. ¿En qué puedo ayudarte?`
    await sendBotMessage({
      workspaceId,
      conversationId: conversation._id,
      content: welcome,
      botId: bot._id,
      io,
    })
  }

  return { handled: true }
}

/**
 * Procesa un mensaje del contacto cuando la conversación está en estado 'bot'.
 * Retorna { shouldEscalate, escalationReason, resolved? }
 */
async function handleMessage({ workspaceId, conversation, userMessage, io, dashboardIo }) {
  logger.info({
    convId: conversation._id,
    status: conversation.status,
    current_bot_id: conversation.current_bot_id,
    current_step_index: conversation.current_step_index,
    awaiting_collect_field: conversation.awaiting_collect?.field,
    userMessage,
  }, '[Bot:handleMessage] entrada')

  // Si el bot estaba esperando un dato del contacto, procesarlo primero.
  // Excepción: el primer mensaje del usuario (el que inició la conversación)
  // llega al backend ANTES de que el usuario haya visto el collect prompt,
  // por eso no debe tratarse como una respuesta de collect.
  if (conversation.awaiting_collect?.field) {
    const contactMsgCount = await Message.countDocuments({
      conversation_id: conversation._id,
      sender_type: 'contact',
    })
    if (contactMsgCount > 1) {
      return handleCollectResponse({ workspaceId, conversation, userMessage, io, dashboardIo })
    }
    // Primer mensaje — ignorar como collect, el bot ya envió el prompt y espera
    return { shouldEscalate: false }
  }

  // Cargar el bot primero para tener acceso al default_department_id en cualquier escalación
  const bot = conversation.current_bot_id
    ? await BotAgent.findById(conversation.current_bot_id).lean()
    : null

  // Detectar solicitud explícita de agente humano
  const userWantsHuman = HUMAN_KEYWORDS.some(kw =>
    userMessage.toLowerCase().includes(kw)
  )
  if (userWantsHuman) {
    await sendBotMessage({
      workspaceId,
      conversationId: conversation._id,
      content: await getBotMessage(workspaceId, 'transfer_to_agent'),
      botId: conversation.current_bot_id,
      io,
    })
    return {
      shouldEscalate:       true,
      escalationReason:     'user_requested',
      assignedDepartmentId: bot?.default_department_id ?? null,
    }
  }

  if (!bot || !bot.active) {
    return { shouldEscalate: true, escalationReason: 'no_active_bot' }
  }

  let result
  if (bot.type === 'decision_bot') {
    result = await handleDecisionStep({ workspaceId, conversation, bot, userMessage, io })
  } else {
    result = await handleAiTurn({ workspaceId, conversation, bot, userMessage, io })
  }

  // Si el bot escala sin departamento asignado, usar el departamento por defecto del bot
  if (result?.shouldEscalate && !result.assignedDepartmentId && bot.default_department_id) {
    result.assignedDepartmentId = bot.default_department_id
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Collect (recolección de datos del contacto)
// ─────────────────────────────────────────────────────────────────────────────

async function handleCollectResponse({ workspaceId, conversation, userMessage, io, dashboardIo }) {
  const { field, collect_key, error_message, next_step_index } = conversation.awaiting_collect
  const value = userMessage.trim()
  let isValid = false

  if (field === 'name') {
    isValid = value.length >= 2
  } else if (field === 'email') {
    isValid = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(value)
  } else if (field === 'phone') {
    isValid = value.replace(/\D/g, '').length >= 7
  } else if (field === 'identification') {
    // Cédula / NIT / pasaporte: solo dígitos, entre 5 y 15 caracteres
    isValid = /^\d{5,15}$/.test(value.replace(/[\s.\-]/g, ''))
  } else if (field === 'text') {
    // Texto libre: solo requiere que no esté vacío
    isValid = value.length > 0
  }

  if (!isValid) {
    const i18nKey = field === 'identification' ? 'collect_id_error' : `collect_${field}_error`
    const errorMsg = error_message || await getBotMessage(workspaceId, i18nKey)
    await sendBotMessage({
      workspaceId,
      conversationId: conversation._id,
      content: errorMsg,
      botId: conversation.current_bot_id,
      io,
    })
    return { shouldEscalate: false }
  }

  // ── text: guardar en bot_collected_data usando collect_key ─────────────────
  if (field === 'text') {
    const key = collect_key || `respuesta_${Date.now()}`
    const nextIndex = next_step_index ?? ((conversation.current_step_index ?? 0) + 1)

    await Conversation.findByIdAndUpdate(conversation._id, {
      [`bot_collected_data.${key}`]: value,
      'awaiting_collect.field':      null,
      current_step_index:            nextIndex,
    })
    conversation.awaiting_collect = { field: null }
    conversation.current_step_index = nextIndex

    const bot = await BotAgent.findById(conversation.current_bot_id).lean()
    if (!bot) return { shouldEscalate: true, escalationReason: 'no_active_bot' }

    if (nextIndex < bot.steps.length) {
      const stepResult = await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: nextIndex, io })
      return stepResult || { shouldEscalate: false }
    }
    return { shouldEscalate: true, escalationReason: 'flow_completed' }
  }

  // ── identification: buscar en el ERP y guardar el contexto en la conversación ──
  if (field === 'identification') {
    const cleanId = value.replace(/[\s.\-]/g, '')
    let erpCustomer = null
    try {
      erpCustomer = await erpService.getCustomer(workspaceId, cleanId)
    } catch (err) {
      // ERP no configurado o error de red — continuar sin contexto ERP
      logger.warn({ err: err.message }, '[Bot] collect_identification: ERP no disponible, continuando sin contexto')
    }

    // Guardar contexto ERP en la conversación (aunque no se encuentre el cliente)
    await Conversation.findByIdAndUpdate(conversation._id, {
      'erp_context.identifier':    cleanId,
      'erp_context.customer_id':   erpCustomer ? String(erpCustomer.id || erpCustomer._id || erpCustomer.code || '') : null,
      'erp_context.customer_name': erpCustomer ? (erpCustomer.name || erpCustomer.name_or_business_name || null) : null,
      'awaiting_collect.field':    null,
    })
    conversation.erp_context = {
      identifier:    cleanId,
      customer_id:   erpCustomer ? String(erpCustomer.id || erpCustomer._id || erpCustomer.code || '') : null,
      customer_name: erpCustomer ? (erpCustomer.name || erpCustomer.name_or_business_name || null) : null,
    }
    conversation.awaiting_collect = { field: null }

    const nextIndex = next_step_index ?? ((conversation.current_step_index ?? 0) + 1)
    await Conversation.findByIdAndUpdate(conversation._id, { current_step_index: nextIndex })
    conversation.current_step_index = nextIndex

    const bot = await BotAgent.findById(conversation.current_bot_id).lean()
    if (!bot) return { shouldEscalate: true, escalationReason: 'no_active_bot' }

    // Si no encontró al cliente en el ERP, notificar y seguir el flujo
    if (!erpCustomer) {
      await sendBotMessage({
        workspaceId,
        conversationId: conversation._id,
        content: await getBotMessage(workspaceId, 'erp_customer_not_found'),
        botId: bot._id,
        io,
      })
      return { shouldEscalate: false }
    }

    if (nextIndex < bot.steps.length) {
      await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: nextIndex, io })
    }
    return { shouldEscalate: false }
  }

  // Guardar en el contacto (name, email, phone)
  const fieldValue = field === 'name'
    ? value.replace(/\b\w/g, c => c.toUpperCase())
    : value

  let targetContactId = conversation.contact_id

  // Deduplicación por email / teléfono: si ya existe un contacto con ese valor
  // en el workspace, redirigir la conversación a ese contacto y eliminar el temporal.
  // EXCEPCIÓN: en canales donde channel_ref ES el teléfono/email del usuario (ej. WhatsApp Baileys),
  // el valor ya identifica al contacto → saltar dedup para no borrar el canal activo.
  if (field === 'email' || field === 'phone') {
    const currentContact = await Contact.findById(conversation.contact_id).lean()
    const isSameAsChannelRef = currentContact?.channel_ref === fieldValue

    if (!isSameAsChannelRef) {
      const existing = await Contact.findOne({
        workspace_id: workspaceId,
        [field]: fieldValue,
        _id: { $ne: conversation.contact_id },
      }).lean()

      if (existing) {
        // Transferir nombre si el contacto temporal ya lo tenía y el existente no
        if (currentContact?.name && currentContact.name !== 'Visitante' &&
            (!existing.name || existing.name === 'Visitante')) {
          await Contact.findByIdAndUpdate(existing._id, { $set: { name: currentContact.name } })
        }
        // Redirigir conversación al contacto existente y eliminar el temporal
        await Conversation.findByIdAndUpdate(conversation._id, { contact_id: existing._id })
        const tempChannelRef  = currentContact?.channel_ref
        const tempChannelType = currentContact?.channel_type
        await Contact.findByIdAndDelete(conversation.contact_id)
        // Transferir el channel_ref del canal activo al contacto existente DESPUÉS de
        // borrar el temporal — así no hay conflicto con el índice único compuesto.
        if (tempChannelRef && tempChannelType) {
          await Contact.findByIdAndUpdate(existing._id, {
            $set: { channel_ref: tempChannelRef, channel_type: tempChannelType },
          })
        }
        targetContactId = existing._id
        logger.info({ field, fieldValue, merged_into: existing._id.toString() }, '[Bot] collect: contacto fusionado con existente')
      }
    }
  }

  const updateResult = await Contact.findByIdAndUpdate(
    targetContactId,
    { $set: { [field]: fieldValue } },
    { new: true }
  )
  logger.info({ field, fieldValue, contact_id: targetContactId?.toString(), updated: !!updateResult }, '[Bot] collect: contacto actualizado')

  // Continuar al siguiente paso
  const nextIndex = next_step_index ?? ((conversation.current_step_index ?? 0) + 1)
  await Conversation.findByIdAndUpdate(conversation._id, {
    'awaiting_collect.field': null,
    current_step_index: nextIndex,
  })
  conversation.awaiting_collect = { field: null }
  conversation.current_step_index = nextIndex

  const bot = await BotAgent.findById(conversation.current_bot_id).lean()
  if (!bot) return { shouldEscalate: true, escalationReason: 'no_active_bot', contactUpdated: true }

  if (nextIndex < bot.steps.length) {
    await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: nextIndex, io })
    return { shouldEscalate: false, contactUpdated: true }
  }
  return { shouldEscalate: true, escalationReason: 'flow_completed', contactUpdated: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision Bot
// ─────────────────────────────────────────────────────────────────────────────

async function handleDecisionStep({ workspaceId, conversation, bot, userMessage, io }) {
  const stepIndex = conversation.current_step_index ?? 0
  const step = bot.steps?.[stepIndex]

  logger.info({
    convId: conversation._id,
    botId: bot._id,
    botName: bot.name,
    stepIndex,
    stepMessage: step?.message?.slice(0, 60),
    optionsCount: step?.options?.length ?? 0,
    stepAction: step?.action?.type,
    userMessage,
  }, '[Bot:handleDecisionStep] procesando')

  if (!step) {
    return { shouldEscalate: true, escalationReason: 'invalid_step' }
  }

  if (step.options?.length > 0) {
    const matched = matchOption(userMessage, step.options)
    logger.info({
      convId: conversation._id,
      userMessage,
      matchedLabel: matched?.label,
      matchedActionType: matched?.action?.type,
      options: step.options.map(o => ({ label: o.label, actionType: o.action?.type })),
    }, '[Bot:handleDecisionStep] resultado matchOption')
    if (matched) {
      return executeAction({ workspaceId, conversation, bot, action: matched.action, io })
    }
    // Sin match: usar acción de fallback del paso o reenviar opciones
    if (step.action) {
      return executeAction({ workspaceId, conversation, bot, action: step.action, io })
    }
    await sendDecisionStep({
      workspaceId, conversation, bot, stepIndex, io,
      prefix: 'No reconocí tu respuesta. Por favor elige una de las opciones:',
    })
    return { shouldEscalate: false }
  }

  // Paso sin opciones: ejecutar acción automática si existe
  if (step.action) {
    return executeAction({ workspaceId, conversation, bot, action: step.action, io })
  }

  // Sin acción: avanzar al siguiente paso
  const nextIndex = stepIndex + 1
  if (nextIndex < bot.steps.length) {
    await Conversation.findByIdAndUpdate(conversation._id, { current_step_index: nextIndex })
    conversation.current_step_index = nextIndex
    await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: nextIndex, io })
  } else {
    return { shouldEscalate: true, escalationReason: 'flow_completed' }
  }

  return { shouldEscalate: false }
}

async function sendDecisionStep({ workspaceId, conversation, bot, stepIndex, io, prefix }) {
  const step = bot.steps?.[stepIndex]
  if (!step) return

  // Construir variables de interpolación disponibles en pasos del bot
  const contact = await Contact.findById(conversation.contact_id).select('name email phone').lean().catch(() => null)
  const stepVars = {
    nombre:   (contact?.name && contact.name !== 'Visitante') ? contact.name : '',
    name:     (contact?.name && contact.name !== 'Visitante') ? contact.name : '',
    email:    contact?.email || '',
    telefono: contact?.phone || '',
    phone:    contact?.phone || '',
  }
  const rawMessage = prefix ? `${prefix}\n\n${step.message}` : step.message
  const content = interpolateMessage(rawMessage, stepVars)
  const options = step.options?.map(o => o.label) ?? []

  await sendBotMessage({
    workspaceId,
    conversationId: conversation._id,
    content,
    options,
    botId: bot._id,
    io,
  })

  // Para pasos sin opciones con acción directa: ejecutar automáticamente
  const action = step.action
  if (!step.options?.length && action) {
    const COLLECT_TYPES = ['collect_name', 'collect_email', 'collect_phone', 'collect_identification', 'collect_text']

    if (COLLECT_TYPES.includes(action.type)) {
      // Collect: activar awaiting_collect y esperar respuesta del usuario
      const field = action.type.replace('collect_', '')
      const nextIndex = action.collect_next_step_index != null ? action.collect_next_step_index : stepIndex + 1

      if (action.collect_message?.trim()) {
        await sendBotMessage({
          workspaceId,
          conversationId: conversation._id,
          content: interpolateMessage(action.collect_message.trim(), stepVars),
          botId: bot._id,
          io,
        })
      }

      await Conversation.findByIdAndUpdate(conversation._id, {
        awaiting_collect: {
          field,
          collect_key:     action.collect_key || null,
          error_message:   action.collect_error_message || null,
          next_step_index: nextIndex,
        },
      })
      return null // esperar input del usuario
    } else {
      // Acción de navegación/escalación/fin: ejecutar de inmediato sin esperar al usuario
      return executeAction({ workspaceId, conversation, bot, action, io })
    }
  }

  return null
}

/**
 * Intenta hacer match entre el texto del usuario y las etiquetas de opciones.
 * Orden: match exacto → match por número → match parcial.
 */
function matchOption(userMessage, options) {
  const norm = userMessage.trim().toLowerCase()

  const exact = options.find(o => o.label.toLowerCase() === norm)
  if (exact) return exact

  if (/^\d+$/.test(norm)) {
    const idx = parseInt(norm, 10) - 1
    if (idx >= 0 && idx < options.length) return options[idx]
  }

  return options.find(o =>
    o.label.toLowerCase().includes(norm) || norm.includes(o.label.toLowerCase())
  ) || null
}

async function executeAction({ workspaceId, conversation, bot, action, io }) {
  // Variables de interpolación disponibles para mensajes de esta acción
  const _contact = await Contact.findById(conversation.contact_id).select('name email phone').lean().catch(() => null)
  const _actionVars = {
    nombre:   (_contact?.name && _contact.name !== 'Visitante') ? _contact.name : '',
    name:     (_contact?.name && _contact.name !== 'Visitante') ? _contact.name : '',
    email:    _contact?.email || '',
    telefono: _contact?.phone || '',
    phone:    _contact?.phone || '',
  }

  switch (action.type) {
    case 'next_step': {
      const nextIndex = (conversation.current_step_index ?? 0) + 1
      if (nextIndex >= bot.steps.length) {
        return { shouldEscalate: true, escalationReason: 'flow_completed' }
      }
      await Conversation.findByIdAndUpdate(conversation._id, { current_step_index: nextIndex })
      conversation.current_step_index = nextIndex
      const nextResult = await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: nextIndex, io })
      return nextResult || { shouldEscalate: false }
    }

    case 'goto_step': {
      const gotoIndex = action.goto_step_index ?? 0
      if (gotoIndex < 0 || gotoIndex >= bot.steps.length) {
        return { shouldEscalate: true, escalationReason: 'invalid_goto' }
      }
      await Conversation.findByIdAndUpdate(conversation._id, { current_step_index: gotoIndex })
      conversation.current_step_index = gotoIndex
      const gotoResult = await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: gotoIndex, io })
      return gotoResult || { shouldEscalate: false }
    }

    case 'route_bot': {
      const targetBot = action.target_bot_id
        ? await BotAgent.findOne({
            _id: action.target_bot_id,
            workspace_id: workspaceId,
            active: true,
          }).lean()
        : null
      if (!targetBot) return { shouldEscalate: true, escalationReason: 'target_bot_not_found' }

      // Detectar loop: si el bot destino ya fue el bot de entrada de esta conversación
      // y ya recolectamos datos del contacto, escalar en vez de reiniciar
      const visitedBots = conversation.visited_bot_ids || []
      const alreadyVisited = visitedBots.some(id => String(id) === String(targetBot._id))
      if (alreadyVisited) {
        logger.warn({ convId: conversation._id, targetBotId: targetBot._id }, '[Bot] route_bot loop detectado — escalando a humano')
        return { shouldEscalate: true, escalationReason: 'bot_loop_detected' }
      }

      const newVisited = [...visitedBots, targetBot._id]
      await Conversation.findByIdAndUpdate(conversation._id, {
        current_bot_id: targetBot._id,
        current_step_index: 0,
        current_agent_turns: 0,
        visited_bot_ids: newVisited,
      })
      conversation.current_bot_id = targetBot._id
      conversation.current_step_index = 0
      conversation.visited_bot_ids = newVisited
      const routeBotResult = await sendDecisionStep({ workspaceId, conversation, bot: targetBot, stepIndex: 0, io })
      return routeBotResult || { shouldEscalate: false }
    }

    case 'route_agent': {
      const targetAgent = action.target_agent_id
        ? await BotAgent.findOne({
            _id: action.target_agent_id,
            workspace_id: workspaceId,
            active: true,
          }).lean()
        : null
      if (!targetAgent) return { shouldEscalate: true, escalationReason: 'target_agent_not_found' }

      await Conversation.findByIdAndUpdate(conversation._id, {
        current_bot_id: targetAgent._id,
        current_step_index: 0,
        current_agent_turns: 0,
      })
      conversation.current_bot_id = targetAgent._id
      conversation.current_agent_turns = 0

      const welcome = extractWelcome(targetAgent.system_prompt) ||
        `Hola, soy ${targetAgent.name}. ¿En qué puedo ayudarte?`
      await sendBotMessage({
        workspaceId,
        conversationId: conversation._id,
        content: welcome,
        botId: targetAgent._id,
        io,
      })
      return { shouldEscalate: false }
    }

    case 'escalate_human': {
      const transferMsg = interpolateMessage(
        action.end_message?.trim() || await getBotMessage(workspaceId, 'transfer_to_agent'),
        _actionVars
      )
      await sendBotMessage({
        workspaceId,
        conversationId: conversation._id,
        content: transferMsg,
        botId: bot._id,
        io,
      })
      return {
        shouldEscalate:       true,
        escalationReason:     'decision_bot_escalation',
        assignedMemberId:     action.assigned_member_id     || null,
        assignedDepartmentId: action.assigned_department_id || null,
      }
    }

    case 'end': {
      if (action.end_message) {
        await sendBotMessage({
          workspaceId,
          conversationId: conversation._id,
          content: interpolateMessage(action.end_message, _actionVars),
          botId: bot._id,
          io,
        })
      }
      await Conversation.findByIdAndUpdate(conversation._id, {
        status: 'resolved',
        resolved_at: new Date(),
      })
      await invalidateAnalyticsCache(workspaceId)
      return { shouldEscalate: false, resolved: true }
    }

    case 'collect_name':
    case 'collect_email':
    case 'collect_phone': {
      const field = action.type.replace('collect_', '') // 'name', 'email' o 'phone'
      const defaults = {
        name:  '¿Cuál es tu nombre?',
        email: '¿Cuál es tu correo electrónico?',
        phone: '¿Cuál es tu número de teléfono?',
      }
      const message = action.collect_message?.trim() || defaults[field]
      const nextIndex = action.collect_next_step_index != null
        ? action.collect_next_step_index
        : (conversation.current_step_index ?? 0) + 1

      await sendBotMessage({
        workspaceId,
        conversationId: conversation._id,
        content: message,
        botId: bot._id,
        io,
      })

      await Conversation.findByIdAndUpdate(conversation._id, {
        awaiting_collect: {
          field,
          collect_key:     null,
          error_message:   action.collect_error_message || null,
          next_step_index: nextIndex,
        },
      })
      return { shouldEscalate: false }
    }

    case 'collect_text': {
      const message = action.collect_message?.trim() || 'Por favor escribe tu respuesta.'
      const nextIndex = action.collect_next_step_index != null
        ? action.collect_next_step_index
        : (conversation.current_step_index ?? 0) + 1

      await sendBotMessage({
        workspaceId,
        conversationId: conversation._id,
        content: message,
        botId: bot._id,
        io,
      })

      await Conversation.findByIdAndUpdate(conversation._id, {
        awaiting_collect: {
          field:           'text',
          collect_key:     action.collect_key || null,
          error_message:   action.collect_error_message || null,
          next_step_index: nextIndex,
        },
      })
      return { shouldEscalate: false }
    }

    // ── Acciones ERP ─────────────────────────────────────────────────────────

    case 'collect_identification': {
      const message = action.collect_message?.trim() || '¿Cuál es tu número de documento (cédula o NIT)?'
      const nextIndex = (conversation.current_step_index ?? 0) + 1

      await sendBotMessage({
        workspaceId,
        conversationId: conversation._id,
        content: message,
        botId: bot._id,
        io,
      })

      await Conversation.findByIdAndUpdate(conversation._id, {
        awaiting_collect: {
          field:           'identification',
          error_message:   action.collect_error_message || null,
          next_step_index: nextIndex,
        },
      })
      return { shouldEscalate: false }
    }

    case 'query_erp_balance': {
      // Requiere que el cliente ya esté identificado en el contexto ERP
      const { customer_id, customer_name, identifier } = conversation.erp_context || {}

      if (!customer_id) {
        await sendBotMessage({
          workspaceId,
          conversationId: conversation._id,
          content: 'Para consultar tu estado de cuenta primero necesito identificarte. ¿Cuál es tu número de documento?',
          botId: bot._id,
          io,
        })
        // Activar collect_identification y reintentar tras identificarse
        const nextIndex = (conversation.current_step_index ?? 0)
        await Conversation.findByIdAndUpdate(conversation._id, {
          awaiting_collect: { field: 'identification', error_message: null, next_step_index: nextIndex },
        })
        return { shouldEscalate: false }
      }

      let balanceMsg = ''
      try {
        const balance = await erpService.getAccountBalance(workspaceId, customer_id, identifier)
        const currency = balance.currency || 'COP'
        if (balance.pending_count === 0) {
          balanceMsg = `${customer_name ? `Hola ${customer_name}, ` : ''}tu cuenta está al día. No tienes facturas pendientes.`
        } else {
          const total = new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(balance.total_balance)
          balanceMsg = `${customer_name ? `Hola ${customer_name}, ` : ''}tienes *${balance.pending_count} factura(s)* pendiente(s) por un total de *${total}*.`
          if (balance.invoices?.length) {
            const lines = balance.invoices.slice(0, 5).map(inv => {
              const num = inv.number || inv.invoice_number || inv.InvoiceId || inv.Id || '—'
              const due = inv.dueDate || inv.due_date || inv.DueDate || ''
              const amt = inv.balance || inv.Balance || inv.outstanding_balance || 0
              const amtFmt = new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amt)
              return `• Factura #${num}${due ? ` — vence ${due}` : ''} — ${amtFmt}`
            })
            balanceMsg += '\n\n' + lines.join('\n')
          }
        }
      } catch (err) {
        logger.error({ err: err.message }, '[Bot] query_erp_balance error')
        balanceMsg = 'Lo siento, no pude consultar tu estado de cuenta en este momento. ¿Deseas hablar con un asesor?'
      }

      await sendBotMessage({
        workspaceId,
        conversationId: conversation._id,
        content: balanceMsg,
        botId: bot._id,
        io,
      })

      // Avanzar al siguiente paso si hay más pasos
      const nextBalanceIndex = (conversation.current_step_index ?? 0) + 1
      if (nextBalanceIndex < bot.steps.length) {
        await Conversation.findByIdAndUpdate(conversation._id, { current_step_index: nextBalanceIndex })
        conversation.current_step_index = nextBalanceIndex
        await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: nextBalanceIndex, io })
      }
      return { shouldEscalate: false }
    }

    case 'query_erp_invoices': {
      const { customer_id, customer_name, identifier } = conversation.erp_context || {}

      if (!customer_id) {
        await sendBotMessage({
          workspaceId,
          conversationId: conversation._id,
          content: 'Para consultar tus facturas primero necesito identificarte. ¿Cuál es tu número de documento?',
          botId: bot._id,
          io,
        })
        const nextIndex = (conversation.current_step_index ?? 0)
        await Conversation.findByIdAndUpdate(conversation._id, {
          awaiting_collect: { field: 'identification', error_message: null, next_step_index: nextIndex },
        })
        return { shouldEscalate: false }
      }

      let invoiceMsg = ''
      try {
        const invoices = await erpService.getInvoices(workspaceId, customer_id)
        if (!invoices?.length) {
          invoiceMsg = `${customer_name ? `${customer_name}, ` : ''}no encontré facturas registradas en el sistema.`
        } else {
          const lines = invoices.slice(0, 8).map(inv => {
            const num = inv.number || inv.invoice_number || inv.InvoiceId || inv.Id || '—'
            const date = inv.date || inv.Date || inv.invoice_date || ''
            const total = inv.total || inv.Total || inv.amount || 0
            const currency = inv.currency || 'COP'
            const amtFmt = new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(total)
            const status = inv.status || inv.Status || ''
            return `• #${num}${date ? ` — ${date}` : ''} — ${amtFmt}${status ? ` (${status})` : ''}`
          })
          invoiceMsg = `${customer_name ? `${customer_name}, ` : ''}estas son tus facturas recientes:\n\n${lines.join('\n')}`
        }
      } catch (err) {
        logger.error({ err: err.message }, '[Bot] query_erp_invoices error')
        invoiceMsg = 'Lo siento, no pude obtener tus facturas en este momento. ¿Deseas hablar con un asesor?'
      }

      await sendBotMessage({
        workspaceId,
        conversationId: conversation._id,
        content: invoiceMsg,
        botId: bot._id,
        io,
      })

      const nextInvIndex = (conversation.current_step_index ?? 0) + 1
      if (nextInvIndex < bot.steps.length) {
        await Conversation.findByIdAndUpdate(conversation._id, { current_step_index: nextInvIndex })
        conversation.current_step_index = nextInvIndex
        await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: nextInvIndex, io })
      }
      return { shouldEscalate: false }
    }

    case 'create_erp_invoice': {
      // erp_action_config debe contener los datos de la factura a crear
      // Se usa típicamente en flujos post-venta automáticos desde el bot de ventas
      const { customer_id } = conversation.erp_context || {}
      if (!customer_id) {
        logger.warn('[Bot] create_erp_invoice: sin erp_context.customer_id')
        return { shouldEscalate: true, escalationReason: 'erp_no_customer' }
      }

      try {
        const invoiceData = { ...(action.erp_action_config || {}), customer_id }
        await erpService.createInvoice(workspaceId, invoiceData)
        const successMsg = action.end_message || 'Tu factura ha sido generada correctamente. En breve la recibirás.'
        await sendBotMessage({
          workspaceId, conversationId: conversation._id, content: successMsg, botId: bot._id, io,
        })
      } catch (err) {
        logger.error({ err: err.message }, '[Bot] create_erp_invoice error')
        await sendBotMessage({
          workspaceId,
          conversationId: conversation._id,
          content: 'No pude generar la factura automáticamente. Un asesor te ayudará en breve.',
          botId: bot._id,
          io,
        })
        return { shouldEscalate: true, escalationReason: 'erp_invoice_error' }
      }

      const nextCreateIndex = (conversation.current_step_index ?? 0) + 1
      if (nextCreateIndex < bot.steps.length) {
        await Conversation.findByIdAndUpdate(conversation._id, { current_step_index: nextCreateIndex })
        conversation.current_step_index = nextCreateIndex
        await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: nextCreateIndex, io })
      }
      return { shouldEscalate: false }
    }

    case 'register_erp_payment': {
      // erp_action_config debe incluir { invoice_id, amount }
      const config = action.erp_action_config || {}
      const { identifier, customer_id } = conversation.erp_context || {}

      if (!config.invoice_id || !config.amount) {
        logger.warn('[Bot] register_erp_payment: falta invoice_id o amount en erp_action_config')
        return { shouldEscalate: true, escalationReason: 'erp_payment_config_error' }
      }

      try {
        await erpService.registerPayment(workspaceId, config.invoice_id, {
          amount:      config.amount,
          customer_id: customer_id || undefined,
          identifier:  identifier || undefined,
          ...config,
        })
        const successMsg = action.end_message || 'Tu pago ha sido registrado correctamente. ¡Gracias!'
        await sendBotMessage({
          workspaceId, conversationId: conversation._id, content: successMsg, botId: bot._id, io,
        })
      } catch (err) {
        logger.error({ err: err.message }, '[Bot] register_erp_payment error')
        await sendBotMessage({
          workspaceId,
          conversationId: conversation._id,
          content: 'No pude registrar el pago en este momento. Un asesor te contactará para confirmarlo.',
          botId: bot._id,
          io,
        })
        return { shouldEscalate: true, escalationReason: 'erp_payment_error' }
      }

      const nextPayIndex = (conversation.current_step_index ?? 0) + 1
      if (nextPayIndex < bot.steps.length) {
        await Conversation.findByIdAndUpdate(conversation._id, { current_step_index: nextPayIndex })
        conversation.current_step_index = nextPayIndex
        await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: nextPayIndex, io })
      }
      return { shouldEscalate: false }
    }

    case 'create_ticket': {
      return createTicketFromConversation({ workspaceId, conversation, bot, action, io })
    }

    case 'send_payment_link': {
      // 1. Cargar el PaymentLink del workspace
      const paymentLink = await PaymentLink.findOne({
        _id: action.payment_link_id,
        workspace_id: workspaceId,
      }).lean()

      if (!paymentLink) {
        // Link no encontrado o no pertenece al workspace
        await sendBotMessage({
          workspaceId,
          conversationId: conversation._id,
          content: 'Lo siento, el enlace de pago no está disponible en este momento.',
          botId: bot._id,
          io,
        })
        return { shouldEscalate: false }
      }

      // 1b. Validar que el link tenga URL
      if (!paymentLink.url) {
        await sendBotMessage({
          workspaceId,
          conversationId: conversation._id,
          content: 'Lo siento, el enlace de pago no está disponible en este momento.',
          botId: bot._id,
          io,
        })
        return { shouldEscalate: false }
      }

      // 2. Construir el mensaje (con producto si está configurado)
      let messageContent = ''

      if (action.product_id) {
        const product = await Product.findOne({
          _id: action.product_id,
          workspace_id: workspaceId,
        }).lean()

        if (product) {
          const currency = product.currency || 'USD'
          const price = new Intl.NumberFormat('es-CO', {
            style: 'currency',
            currency,
            maximumFractionDigits: 0,
          }).format(product.price)
          messageContent = `*${product.name}* — ${price}\n\n`
        }
      }

      // El success_message de la acción o texto default
      const linkText = action.success_message?.trim() ||
        'Puedes completar tu pago en el siguiente enlace:'

      messageContent += `${linkText}\n\n${paymentLink.url}`

      // 3. Enviar el mensaje al cliente
      await sendBotMessage({
        workspaceId,
        conversationId: conversation._id,
        content: messageContent,
        botId: bot._id,
        io,
      })

      // 4. Vincular el PaymentLink a esta conversación y contacto
      await PaymentLink.findByIdAndUpdate(paymentLink._id, {
        $set: {
          conversation_id: conversation._id,
          contact_id:      conversation.contact_id,
        },
      })

      // 5. Avanzar al siguiente paso del flujo
      const nextIdx = (conversation.current_step_index ?? 0) + 1
      if (nextIdx < bot.steps.length) {
        await Conversation.findByIdAndUpdate(conversation._id, { current_step_index: nextIdx })
        conversation.current_step_index = nextIdx
        const stepResult = await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: nextIdx, io })
        return stepResult || { shouldEscalate: false }
      }
      return { shouldEscalate: true, escalationReason: 'flow_completed' }
    }

    default:
      return { shouldEscalate: false }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Create ticket from conversation (decision bot action)
// ─────────────────────────────────────────────────────────────────────────────

async function createTicketFromConversation({ workspaceId, conversation, bot, action, io }) {
  const config = action.ticket_config || {}
  const priority = config.priority || 'medium'

  // Cargar contacto, mensajes y workspace en paralelo
  const [contact, messages, freshConv, workspace] = await Promise.all([
    Contact.findById(conversation.contact_id).select('name email phone').lean(),
    Message.find({
      conversation_id: conversation._id,
      sender_type: { $in: ['contact', 'bot'] },
      content: { $ne: '' },
    }).sort({ createdAt: 1 }).lean(),
    Conversation.findById(conversation._id).select('bot_collected_data').lean(),
    Workspace.findById(workspaceId).select('name').lean(),
  ])

  let title = 'Solicitud de soporte'
  let description = 'El cliente solicitó asistencia a través del chatbot.'

  // ── Construir contexto estructurado para el LLM ────────────────────────────

  const sections = []

  // 1. Datos del contacto conocidos
  const contactLines = []
  if (contact?.name && contact.name !== 'Visitante') contactLines.push(`- Nombre: ${contact.name}`)
  if (contact?.email)  contactLines.push(`- Email: ${contact.email}`)
  if (contact?.phone)  contactLines.push(`- Teléfono: ${contact.phone}`)
  if (contactLines.length) sections.push(`=== DATOS DEL CLIENTE ===\n${contactLines.join('\n')}`)

  // 2. Respuestas de texto libre (collect_text con clave)
  const collectedData = freshConv?.bot_collected_data
  if (collectedData && collectedData.size > 0) {
    const dataLines = []
    for (const [key, value] of collectedData.entries()) {
      const label = key.replace(/_/g, ' ')
      dataLines.push(`- ${label}: ${value}`)
    }
    if (dataLines.length) sections.push(`=== INFORMACIÓN PROPORCIONADA POR EL CLIENTE ===\n${dataLines.join('\n')}`)
  }

  // 3. Transcripción limpia:
  //    - Todos los mensajes del cliente
  //    - Solo mensajes del bot que sean preguntas cortas (no menús de opciones)
  if (messages.length > 0) {
    const transcriptLines = []
    for (const m of messages) {
      const text = m.content.trim()
      if (!text) continue
      if (m.sender_type === 'contact') {
        transcriptLines.push(`Cliente: ${text}`)
      } else {
        // Excluir mensajes del bot que parecen menús (tienen líneas numeradas o son muy largos con saltos)
        const looksLikeMenu = /\n\s*\d+[\.\)]\s+\S/.test(text) || (text.includes('\n') && text.length > 200)
        if (!looksLikeMenu) transcriptLines.push(`Bot: ${text}`)
      }
    }
    if (transcriptLines.length) sections.push(`=== CONVERSACIÓN ===\n${transcriptLines.join('\n')}`)
  }

  if (sections.length > 0) {
    const contextBlock = sections.join('\n\n')

    const systemPrompt = `Eres un agente de soporte que convierte el contexto de una conversación en un ticket de ayuda.

Tu tarea es analizar TODA la información disponible y generar:
1. Un TÍTULO corto y específico del problema o solicitud (máximo 80 caracteres). Debe reflejar el asunto principal.
2. Una DESCRIPCIÓN completa en texto plano que incluya obligatoriamente:
   - El motivo o problema principal del cliente
   - TODOS los datos específicos que proporcionó (dirección, número de documento, número de orden, descripción del problema, fechas, etc.)
   - Cualquier contexto adicional relevante para resolverlo
   - Datos de contacto si los hay

La descripción debe ser útil para el agente que atienda el ticket, incluyendo TODOS los detalles sin omitir nada.
Responde ÚNICAMENTE con un JSON en una sola línea, sin markdown, sin bloques de código:
{"title":"...","description":"..."}`

    try {
      const llmResult = await callLLM(
        [{ role: 'user', content: contextBlock }],
        { workspaceId, systemPrompt }
      )

      // Limpiar posibles bloques markdown del LLM antes de parsear
      const raw = llmResult.content.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim()

      const parsed = JSON.parse(raw)
      if (parsed.title)       title       = String(parsed.title).slice(0, 80)
      if (parsed.description) description = String(parsed.description)
    } catch (err) {
      logger.warn({ err: err.message }, '[Bot] create_ticket: LLM falló, usando fallback')

      // Fallback: construir descripción con los datos estructurados disponibles
      const fallbackParts = []
      if (sections[0]) fallbackParts.push(sections[0]) // datos del contacto
      if (sections[1] && sections[1].startsWith('=== INFORMACIÓN')) fallbackParts.push(sections[1])

      const firstContactMsg = messages.find(m => m.sender_type === 'contact')
      if (firstContactMsg) {
        title = firstContactMsg.content.trim().slice(0, 80)
      }
      description = fallbackParts.length
        ? fallbackParts.join('\n\n').replace(/=== .+ ===\n/g, '')
        : messages.filter(m => m.sender_type === 'contact').map(m => m.content.trim()).join('\n')
    }
  }

  let ticket
  try {
    const ticket_number = await generateUniqueCode(Ticket, 'ticket_number', { workspace_id: workspaceId }, 10000, 99999999)
    ticket = await Ticket.create({
      workspace_id:    workspaceId,
      contact_id:      conversation.contact_id,
      conversation_id: conversation._id,
      ticket_number,
      title,
      description,
      priority,
      status:          'open',
      ...(config.assigned_member_id ? { assigned_to: config.assigned_member_id } : {}),
      ...((config.assigned_department_id || bot.default_department_id)
        ? { department_id: config.assigned_department_id || bot.default_department_id }
        : {}),
    })
    logger.info({ workspaceId, conversationId: conversation._id.toString(), ticketId: ticket._id.toString(), ticket_number }, '[Bot] Ticket creado desde conversación')
  } catch (err) {
    logger.error({ err: err.message }, '[Bot] create_ticket: error al crear ticket')
    await sendBotMessage({
      workspaceId,
      conversationId: conversation._id,
      content: 'Lo siento, no pude registrar tu solicitud en este momento. Te conectaré con un agente.',
      botId: bot._id,
      io,
    })
    return { shouldEscalate: true, escalationReason: 'ticket_creation_error' }
  }

  // Enviar copia del ticket al email del contacto si tiene uno registrado
  if (contact?.email) {
    mailer.sendTicketConfirmation({
      to:            contact.email,
      name:          contact.name && contact.name !== 'Visitante' ? contact.name : null,
      ticketId:      String(ticket.ticket_number),
      title,
      description,
      priority,
      workspaceName: workspace?.name || null,
    }).catch((err) => logger.warn({ err: err.message, contactEmail: contact.email }, '[Bot] No se pudo enviar email de confirmación de ticket'))
  }

  // Variables disponibles para interpolación en el mensaje de confirmación
  const templateVars = {
    ticket:   String(ticket.ticket_number),
    numero:   String(ticket.ticket_number),
    nombre:   (contact?.name && contact.name !== 'Visitante') ? contact.name : '',
    email:    contact?.email  || '',
    telefono: contact?.phone  || '',
    phone:    contact?.phone  || '',
    name:     (contact?.name && contact.name !== 'Visitante') ? contact.name : '',
  }

  const rawSuccessMsg = config.success_message?.trim()
    || await getBotMessage(workspaceId, 'ticket_created', { ticket: ticket.ticket_number })
  const successMsg = interpolateMessage(rawSuccessMsg, templateVars)

  await sendBotMessage({
    workspaceId,
    conversationId: conversation._id,
    content: successMsg,
    botId: bot._id,
    io,
  })

  // ── Ejecutar post_action ──────────────────────────────────────────────────
  const postAction = config.post_action || 'end'

  if (postAction === 'next_step') {
    const nextIndex = (conversation.current_step_index ?? 0) + 1
    if (nextIndex < bot.steps.length) {
      await Conversation.findByIdAndUpdate(conversation._id, { current_step_index: nextIndex })
      conversation.current_step_index = nextIndex
      const stepResult = await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: nextIndex, io })
      return stepResult || { shouldEscalate: false }
    }
    // Sin más pasos → resolver
  } else if (postAction === 'goto_step' && config.post_goto_step_index != null) {
    const gotoIndex = config.post_goto_step_index
    if (gotoIndex >= 0 && gotoIndex < bot.steps.length) {
      await Conversation.findByIdAndUpdate(conversation._id, { current_step_index: gotoIndex })
      conversation.current_step_index = gotoIndex
      const stepResult = await sendDecisionStep({ workspaceId, conversation, bot, stepIndex: gotoIndex, io })
      return stepResult || { shouldEscalate: false }
    }
    // Índice inválido → resolver
  } else if (postAction === 'escalate_human') {
    return {
      shouldEscalate: true,
      escalationReason: 'create_ticket_post_action',
      assignedMemberId:     config.post_escalate_member_id                                    || null,
      assignedDepartmentId: config.post_escalate_department_id || bot.default_department_id || null,
    }
  }
  // postAction === 'end' o fallback: resolver la conversación
  await Conversation.findByIdAndUpdate(conversation._id, {
    status: 'resolved',
    resolved_at: new Date(),
  })
  await invalidateAnalyticsCache(workspaceId)
  return { shouldEscalate: false, resolved: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Agent
// ─────────────────────────────────────────────────────────────────────────────

async function handleAiTurn({ workspaceId, conversation, bot, userMessage, io }) {
  // ── Modo protocolo ────────────────────────────────────────────────────────
  // Solo se activa si el bot tiene protocol_id configurado.
  // Si no, el flujo normal de RAG continúa sin ningún cambio.
  if (bot.protocol_id) {
    const protocol = await KnowledgeItem.findById(bot.protocol_id).lean()

    if (!protocol || protocol.type !== 'protocol') {
      logger.warn({ botId: bot._id, protocolId: bot.protocol_id }, '[Bot] protocol_id inválido o no es tipo "protocol"; usando flujo RAG normal')
      // caer al flujo RAG normal (continúa abajo)
    } else {
      // Inicializar protocolo si aún no está activo en esta conversación
      if (!conversation.active_protocol_id) {
        await protocolService.initProtocol(conversation._id, bot.protocol_id)
        conversation.active_protocol_step = 1
        conversation.protocol_step_turns  = 0
        conversation.protocol_completed   = false
      }

      // Si el protocolo ya terminó, continuar con flujo RAG libre
      if (!protocolService.isProtocolComplete(conversation, protocol)) {
        // ── Turno de protocolo ──────────────────────────────────────────────
        const turns = (conversation.current_agent_turns ?? 0) + 1

        if (turns > (bot.max_turns ?? 8)) {
          await sendBotMessage({
            workspaceId,
            conversationId: conversation._id,
            content: await getBotMessage(workspaceId, 'max_turns_reached'),
            botId: bot._id,
            io,
          })
          return { shouldEscalate: true, escalationReason: 'max_turns_reached' }
        }

        await Conversation.findByIdAndUpdate(conversation._id, { current_agent_turns: turns })

        const workspace = await Workspace.findById(workspaceId).lean()
        if (!workspace) {
          logger.warn({ workspaceId, convId: conversation._id }, '[Protocol] Workspace no encontrado, escalando')
          return { shouldEscalate: true, escalationReason: 'workspace_not_found' }
        }
        const history   = await Message.find({ conversation_id: conversation._id })
          .sort({ createdAt: -1 }).limit(50).lean()
        history.reverse()
        const hasExistingBotMessages = history.some(m => m.sender_type === 'bot')

        await extractAndSaveContactData(conversation.contact_id, history)

        const contextText  = protocolService.getCurrentStepContext(conversation, protocol)
        const systemPrompt = buildAgentSystemPrompt(bot, workspace, contextText, turns, hasExistingBotMessages)
        const messages     = buildMessageHistory(history, userMessage)

        if (io) io.to(`conv:${conversation._id}`).emit('typing:start')

        let llmContent = ''
        let llmResult
        try {
          llmResult = await callLLM(messages, {
            workspaceId,
            systemPrompt,
            provider:  bot.provider  || undefined,
            model:     bot.model     || undefined,
            workspace,
          })
          llmContent = llmResult.content
        } catch (err) {
          logger.error({ err: err.message, agentId: bot._id }, '[Bot] Error llamando al LLM (protocolo)')
          await sendBotMessage({
            workspaceId,
            conversationId: conversation._id,
            content: 'Lo siento, estoy teniendo problemas técnicos. Te conecto con un agente.',
            botId: bot._id,
            io,
          })
          return { shouldEscalate: true, escalationReason: 'api_error' }
        }

        const result = await protocolService.processStepCompletion(conversation, protocol, llmContent)

        if (result.duplicateDetected) {
          // Ignorar este turno, ya fue procesado por otro proceso concurrente
          return { shouldEscalate: false }
        }

        if (result.shouldEscalate) {
          return { shouldEscalate: true, escalationReason: result.reason }
        }

        await sendBotMessage({
          workspaceId,
          conversationId: conversation._id,
          content: result.cleanResponse || 'Te estoy conectando con un agente.',
          botId: bot._id,
          io,
          aiMeta: {
            model:              `${llmResult.provider}/${llmResult.model}`,
            input_tokens:       llmResult.input_tokens,
            output_tokens:      llmResult.output_tokens,
            agent_id:           bot._id.toString(),
            knowledge_item_ids: [],
          },
        })

        return { shouldEscalate: false }
      }

      // Protocolo completado — marcar en MongoDB y continuar con RAG libre
      await Conversation.findByIdAndUpdate(conversation._id, { protocol_completed: true })
      logger.info({ conversationId: conversation._id, protocolId: bot.protocol_id }, '[Bot] Protocolo completado; continuando con flujo RAG libre')
    }
  }
  // ── Fin del bloque de protocolo ───────────────────────────────────────────

  const turns = (conversation.current_agent_turns ?? 0) + 1

  if (turns > (bot.max_turns ?? 8)) {
    await sendBotMessage({
      workspaceId,
      conversationId: conversation._id,
      content: await getBotMessage(workspaceId, 'max_turns_reached'),
      botId: bot._id,
      io,
    })
    return { shouldEscalate: true, escalationReason: 'max_turns_reached' }
  }

  await Conversation.findByIdAndUpdate(conversation._id, { current_agent_turns: turns })

  // ── Consulta automática de estado de ticket (proceso interno, sin KB) ────
  // Si el cliente pregunta por el estado de su caso/ticket, se responde
  // automáticamente con los datos reales sin necesitar procedimiento en el documento.
  if (TICKET_STATUS_PATTERNS.some(p => p.test(userMessage))) {
    const tickets = await Ticket.find({
      $or: [
        { conversation_id: conversation._id },
        { contact_id: conversation.contact_id },
      ],
      workspace_id: workspaceId,
    }).sort({ createdAt: -1 }).limit(5).lean()

    if (tickets.length > 0) {
      const statusLabels = { open: 'Abierto', in_progress: 'En progreso', waiting: 'En espera', resolved: 'Resuelto', closed: 'Cerrado' }
      const ticketLines = tickets.map(t => {
        const ref  = t._id.toString().slice(-8).toUpperCase()
        const stat = statusLabels[t.status] || t.status
        const date = t.createdAt ? new Date(t.createdAt).toLocaleDateString('es-CO') : ''
        return `• Caso #${ref} — ${stat}${date ? ` (${date})` : ''}: ${t.title}`
      }).join('\n')

      await sendBotMessage({
        workspaceId,
        conversationId: conversation._id,
        content: `Aquí está el estado de tus casos registrados:\n\n${ticketLines}\n\n¿Hay algo más en lo que pueda ayudarte?`,
        botId: bot._id,
        io,
      })
      return { shouldEscalate: false }
    }
  }

  // ── Historial completo de la conversación (memoria de la IA) ────────────
  // No reducir: el historial es la única "memoria" del agente. Si se recorta
  // en conversaciones largas (>15 pasos), el bot pierde contexto de datos ya
  // recogidos y repite preguntas o pierde el hilo del procedimiento.
  const history = await Message.find({ conversation_id: conversation._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean()
  history.reverse()

  // ── Fase de registro: extraer datos del historial y persistir PRIMERO ───
  // Así, si el usuario acaba de proporcionar un dato, queda guardado antes
  // de que evaluemos qué campos siguen faltando.
  const contactBefore = await Contact.findById(conversation.contact_id).select('name phone email custom_fields').lean()
  const hadMissingBefore = getMissingRegistrationFields(contactBefore, bot).length > 0
  await extractAndSaveContactData(conversation.contact_id, history)
  const contact = await Contact.findById(conversation.contact_id).select('name phone email custom_fields').lean()
  const missingFields = getMissingRegistrationFields(contact, bot)
  const registrationComplete = missingFields.length === 0
  // True cuando el usuario acaba de entregar el último dato requerido en este turno
  const justCompletedRegistration = hadMissingBefore && registrationComplete

  const workspace = await Workspace.findById(workspaceId).lean()
  const hasExistingBotMessages = history.some(m => m.sender_type === 'bot')

  // ── Si el registro no está completo, usar prompt de registro (sin RAG) ──
  if (!registrationComplete) {
    const systemPrompt = buildRegistrationSystemPrompt(bot, workspace, missingFields, hasExistingBotMessages)
    const messages = buildMessageHistory(history, userMessage)

    if (io) io.to(`conv:${conversation._id}`).emit('typing:start')

    let llmContent = ''
    try {
      const llmResult = await callLLM(messages, {
        workspaceId,
        systemPrompt,
        provider: bot.provider || undefined,
        model:    bot.model    || undefined,
        workspace,
      })
      llmContent = llmResult.content
    } catch (err) {
      logger.error({ err: err.message, agentId: bot._id }, 'Error llamando al LLM (registro)')
      llmContent = `Por favor dime tu ${missingFields[0].label} para continuar.`
    }

    await sendBotMessage({
      workspaceId,
      conversationId: conversation._id,
      content: llmContent.trim(),
      botId: bot._id,
      io,
    })

    logger.info({ workspaceId, turns, missingField: missingFields[0].field }, '[Bot] Fase de registro: solicitando dato')
    return { shouldEscalate: false }
  }

  // ── Detección de intención ────────────────────────────────────────────────
  const conversational = isConversationalMessage(userMessage, turns)

  // ── Estrategia de contexto (RAG puro) ───────────────────────────────────
  let knowledgeContext = ''
  let knowledgeItemIds = []

  if (bot.knowledge_item_ids?.length && !conversational && !justCompletedRegistration) {
    // Primer mensaje del cliente = intención original (problema real que trajo al cliente)
    const firstClientMessage = history.find(m => m.sender_type === 'contact')
    const lastBotMsg = [...history].reverse().find(m => m.sender_type === 'bot')

    // FASE DE REGISTRO (turns <= 6): RAG busca protocolo de inicio + datos del cliente.
    // FASE DE ATENCIÓN (turns > 6): el registro ya está completo; pivotar el RAG al
    // problema original del cliente para traer contexto relevante de la KB.
    // Si el mensaje actual es corto (nombre, cédula, "sí", número) usamos la intención
    // original en lugar del texto literal para no confundir el buscador semántico.
    const isRegistrationResponse = userMessage.trim().length < 40
    const ragQuery = turns <= 6
      ? (turns <= 2
          ? `protocolo inicio conversación saludo datos cliente ${userMessage}`
          : isRegistrationResponse && firstClientMessage
            ? `protocolo registro datos cliente ${firstClientMessage.content}`
            : userMessage)
      : (isRegistrationResponse && firstClientMessage
          ? firstClientMessage.content
          : userMessage.trim().length < 30 && lastBotMsg
            ? `${lastBotMsg.content} ${userMessage}`
            : userMessage)

    // Protocol chunks solo en los primeros 2 turnos del flujo KB (registro ya fue resuelto por el backend)
    let protocolChunks = []
    if (turns <= 2) {
      try {
        protocolChunks = await getProtocolChunks(workspaceId, bot.knowledge_item_ids.map(id => id.toString()))
      } catch (err) {
        logger.warn({ err: err.message, workspaceId }, '[Bot] getProtocolChunks falló, continuando sin protocolo')
      }
    }

    const ragItems = await knowledgeService.searchRelevant(workspaceId, ragQuery, {
      filterIds:    bot.knowledge_item_ids,
      topK:         bot.rag_top_k ?? 8,
      keywordQuery: userMessage,
    })

    if (ragItems.length > 0 || protocolChunks.length > 0) {
      knowledgeItemIds = [...new Set(ragItems.map(r => r.item._id?.toString()))]

      // Protocolo al inicio, luego el contexto semántico (sin duplicar chunks que ya están)
      const protocolText = protocolChunks.length > 0
        ? `### PROTOCOLO DE ATENCIÓN (leer siempre primero)\n\n` +
          protocolChunks.map(c => c.text).join('\n\n') +
          `\n\n---\n\n`
        : ''

      const semanticText = ragItems.map(r => {
        const label = r.item.type === 'spreadsheet' ? ' [Excel]' : ''
        return `## ${r.item.title}${label}\n\n${r.item.content}`
      }).join('\n\n---\n\n')

      knowledgeContext = protocolText + semanticText
      ragItems.forEach(r => knowledgeService.incrementUsage(r.item._id).catch(() => {}))
    }

    logger.info({ workspaceId, protocolChunks: protocolChunks.length, ragChunks: ragItems.length, chars: knowledgeContext.length }, '[Bot] Contexto RAG listo')
  }

  const systemPrompt = buildAgentSystemPrompt(bot, workspace, knowledgeContext, turns, hasExistingBotMessages)
  const messages = buildMessageHistory(history, userMessage)

  let llmContent    = ''
  let inputTokens   = 0
  let outputTokens  = 0
  let resolvedModel = bot.model || null

  // Indicar al widget que el agente está escribiendo
  if (io) io.to(`conv:${conversation._id}`).emit('typing:start')

  try {
    const llmResult = await callLLM(messages, {
      workspaceId,
      systemPrompt,
      // Si el bot tiene provider/model explícitos los usa; si no, hereda del workspace
      provider:  bot.provider  || undefined,
      model:     bot.model     || undefined,
      workspace,
    })
    llmContent    = llmResult.content
    inputTokens   = llmResult.input_tokens
    outputTokens  = llmResult.output_tokens
    resolvedModel = `${llmResult.provider}/${llmResult.model}`
  } catch (err) {
    logger.error({ err: err.message, agentId: bot._id }, 'Error llamando al LLM')
    await sendBotMessage({
      workspaceId,
      conversationId: conversation._id,
      content: 'Lo siento, estoy teniendo problemas técnicos. Te conecto con un agente.',
      botId: bot._id,
      io,
    })
    return { shouldEscalate: true, escalationReason: 'api_error' }
  }

  const signals = parseSignals(llmContent)

  const shouldEscalate = signals.shouldEscalate ||
    (bot.escalate_on_low_confidence && signals.lowConfidence)

  // [cerrar] solo se acepta si el cliente confirmó que quedó conforme Y
  // hay suficientes turnos para garantizar que no es un cierre prematuro.
  const clientConfirmedClose = /\b(gracias|de nada|listo|ok|perfecto|bien|genial|resuelto|todo bien|que tengas|chao|adiós|hasta luego)\b/i.test(userMessage)
  const shouldClose    = signals.shouldClose && turns > 12 && clientConfirmedClose
  const ticketDeptName = signals.ticketDept
  const shouldLead     = signals.shouldLead
  const escalateDept   = signals.escalateDept

  const cleanResponse = stripSignals(llmContent)

  await sendBotMessage({
    workspaceId,
    conversationId: conversation._id,
    content: cleanResponse || 'Te estoy conectando con un agente.',
    botId: bot._id,
    io,
    aiMeta: {
      model:              resolvedModel,
      input_tokens:       inputTokens,
      output_tokens:      outputTokens,
      knowledge_item_ids: knowledgeItemIds,
      agent_id:           bot._id.toString(),
    },
  })

  // Creación de ticket por señal del documento: [CREAR_TICKET:Departamento]
  // El LLM emite esta señal SOLO cuando el protocolo del documento lo indica.
  // No hay clasificador automático — el documento es el único que decide cuándo crear ticket.
  if (ticketDeptName) {
    try {
      const existingTicketCount = await Ticket.countDocuments({
        conversation_id: conversation._id,
        workspace_id:    workspaceId,
      })

      if (existingTicketCount === 0) {
        const departments  = await Department.find({ workspace_id: workspaceId }).lean()
        const deptNameLow  = ticketDeptName.toLowerCase()
        const matchedDept  = departments.find(d =>
          d.name.toLowerCase() === deptNameLow ||
          d.name.toLowerCase().includes(deptNameLow) ||
          deptNameLow.includes(d.name.toLowerCase())
        )
        const deptId = matchedDept?._id || bot.default_department_id || null

        // Generar título y descripción con el LLM a partir del historial
        const ticketMessages = await Message.find({
          conversation_id: conversation._id,
          sender_type: { $in: ['contact', 'bot'] },
          content: { $ne: '' },
        }).sort({ createdAt: 1 }).lean()

        const contact = await Contact.findById(conversation.contact_id)
          .select('name email phone').lean()

        let title = 'Solicitud del cliente'
        let description = ''
        try {
          const transcriptLines = ticketMessages.map(m => {
            const looksLikeMenu = /\n\s*\d+[\.\)]\s+\S/.test(m.content) || (m.content.includes('\n') && m.content.length > 200)
            if (m.sender_type === 'contact') return `Cliente: ${m.content.trim()}`
            if (!looksLikeMenu) return `Agente: ${m.content.trim()}`
            return null
          }).filter(Boolean).join('\n')

          const tktSystemPrompt = `Eres un agente que convierte una conversación de soporte en un ticket. Genera un título corto (máx 80 chars) y una descripción completa con todos los datos relevantes del diagnóstico. Responde ÚNICAMENTE con JSON en una sola línea: {"title":"...","description":"..."}`
          const tktResult = await callLLM(
            [{ role: 'user', content: transcriptLines }],
            { workspaceId, systemPrompt: tktSystemPrompt }
          )
          const parsed = JSON.parse(tktResult.content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''))
          if (parsed.title)       title       = String(parsed.title).slice(0, 80)
          if (parsed.description) description = String(parsed.description)
        } catch (_) {
          const firstClientMsg = ticketMessages.find(m => m.sender_type === 'contact')
          if (firstClientMsg) title = firstClientMsg.content.trim().slice(0, 80)
        }

        const ticketNumber = await generateUniqueCode(Ticket, 'ticket_number', { workspace_id: workspaceId }, 10000, 99999999)
        const newTicket = await Ticket.create({
          workspace_id:    workspaceId,
          contact_id:      conversation.contact_id,
          conversation_id: conversation._id,
          ticket_number:   ticketNumber,
          title,
          description,
          priority:        'medium',
          status:          'open',
          department_id:   deptId,
          assigned_to:     null,
        })

        // Enviar confirmación del número de caso al cliente
        await sendBotMessage({
          workspaceId,
          conversationId: conversation._id,
          content: await getBotMessage(workspaceId, 'ticket_created', { ticket: newTicket.ticket_number }),
          botId: bot._id,
          io,
        })

        // Notificar por email si el contacto tiene correo
        if (contact?.email) {
          const workspace = await Workspace.findById(workspaceId).select('name').lean()
          mailer.sendTicketConfirmation({
            to: contact.email,
            name: contact.name && contact.name !== 'Visitante' ? contact.name : null,
            ticketId: String(newTicket.ticket_number),
            title,
            description,
            priority: 'medium',
            workspaceName: workspace?.name || null,
          }).catch(err => logger.warn({ err: err.message }, '[Bot] No se pudo enviar email de ticket'))
        }

        logger.info({ workspaceId, conversationId: conversation._id.toString(), deptId, ticket_number: newTicket.ticket_number, dept: ticketDeptName }, '[Bot] Ticket creado por señal del documento')
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[Bot] Error al crear ticket por señal')
    }
  }

  // ── Creación de lead por señal [lead] ────────────────────────────────────────
  if (shouldLead) {
    try {
      const existingLead = await Lead.exists({
        conversation_id: conversation._id,
        workspace_id:    workspaceId,
      })
      if (!existingLead) {
        await Lead.create({
          workspace_id:    workspaceId,
          contact_id:      conversation.contact_id,
          conversation_id: conversation._id,
          stage:           'new',
        })
        logger.info({ workspaceId, conversationId: conversation._id.toString() }, '[Bot] Lead creado por señal del documento')
      }
    } catch (err) {
      logger.warn({ err: err.message }, '[Bot] Error al crear lead por señal')
    }
  }

  // ── Escalación (con o sin departamento) ─────────────────────────────────────
  if (shouldEscalate) {
    let assignedDepartmentId = null
    if (escalateDept) {
      try {
        const departments = await Department.find({ workspace_id: workspaceId }).lean()
        const deptLow = escalateDept.toLowerCase()
        const match = departments.find(d =>
          d.name.toLowerCase() === deptLow ||
          d.name.toLowerCase().includes(deptLow) ||
          deptLow.includes(d.name.toLowerCase())
        )
        if (match) assignedDepartmentId = match._id
      } catch (_) {}
    }
    return {
      shouldEscalate:       true,
      escalationReason:     'agent_signal',
      assignedDepartmentId: assignedDepartmentId || null,
    }
  }

  if (shouldClose) {
    await Conversation.findByIdAndUpdate(conversation._id, {
      status: 'resolved',
      resolved_at: new Date(),
    })
    await invalidateAnalyticsCache(workspaceId)
    return { shouldEscalate: false, resolved: true }
  }

  return { shouldEscalate: false }
}

async function runTicketClassifier({ workspaceId, bot, conversation, messages = [], contact = null }) {
  const departments = await Department.find({ workspace_id: workspaceId }).lean()
  const deptNames = departments.length > 0
    ? departments.map(d => d.name).join(', ')
    : 'Ventas, Soporte, Facturación'

  // Construir transcripción limpia del historial completo
  const transcriptLines = []
  for (const m of messages) {
    const text = m.content?.trim()
    if (!text) continue
    if (m.sender_type === 'contact') {
      transcriptLines.push(`Cliente: ${text}`)
    } else if (m.sender_type === 'bot') {
      const looksLikeMenu = /\n\s*\d+[\.\)]\s+\S/.test(text) || (text.includes('\n') && text.length > 200)
      if (!looksLikeMenu) transcriptLines.push(`Agente: ${text}`)
    }
  }
  const transcript = transcriptLines.join('\n') || '(conversación vacía)'

  // Datos del contacto ya conocidos
  const contactParts = []
  if (contact?.name && contact.name !== 'Visitante') contactParts.push(`Nombre: ${contact.name}`)
  if (contact?.email) contactParts.push(`Email: ${contact.email}`)
  if (contact?.phone) contactParts.push(`Teléfono: ${contact.phone}`)
  const contactInfo = contactParts.length > 0 ? contactParts.join(' | ') : 'Sin datos registrados'

  const systemPrompt = `Eres un clasificador de conversaciones de atención al cliente. Debes decidir si la conversación ha llegado a un punto de cierre que justifique crear un ticket de seguimiento interno.

CREA un ticket SOLO cuando se cumplan TODAS estas condiciones:
1. El agente COMPLETÓ su proceso: hizo todas las preguntas del protocolo o diagnóstico, no está a mitad de camino
2. Hay un resultado claro que requiere acción del equipo humano (visita técnica confirmada, venta concretada, problema documentado completamente, revisión de cuenta solicitada)
3. El cliente proporcionó su nombre y al menos un método de contacto (correo o teléfono) durante la conversación

NO crees un ticket cuando:
- El último mensaje del agente contiene una pregunta directa, una instrucción de diagnóstico o espera respuesta del cliente (ej: "reinicia el módem y avísame", "¿puedes hacer X?", "dime cuándo...") — el proceso sigue activo
- El diagnóstico o proceso sigue en curso (el agente todavía está investigando el problema)
- El cliente solo preguntó algo informativo y quedó satisfecho sin requerir seguimiento
- Faltan datos del cliente (nombre y contacto) — el agente debe pedirlos primero
- La conversación acaba de empezar o tiene menos de 8 intercambios reales
- El cliente quiere hablar con un humano ahora mismo
- El problema no ha llegado a una conclusión: no se confirmó visita técnica, no se documentó que el problema persiste tras los pasos de diagnóstico, no se cerró el caso

Departamentos disponibles: ${deptNames}

Si decides crear el ticket, extrae del historial los datos del cliente. IMPORTANTE para la extracción:
- client_phone: SOLO números de teléfono reales (móvil colombiano: 10 dígitos empezando por 3, o fijo: 7 dígitos). NUNCA pongas aquí cédulas, NITs ni documentos de identidad.
- client_identification: cédula, NIT, pasaporte u otro documento de identidad (generalmente 6-10 dígitos, NO empieza por 3 como los móviles).
- Si un número podría ser cédula o teléfono, y en la conversación se mencionó explícitamente como cédula/documento/identificación, va en client_identification, NO en client_phone.

Responde ÚNICAMENTE con JSON en una sola línea sin markdown ni bloques de código.
Sin ticket: {"should_create_ticket":false}
Con ticket: {"should_create_ticket":true,"ticket_type":"venta|soporte|facturacion|agendamiento|otro","suggested_department":"<nombre exacto del departamento>","ticket_title":"<título máx 80 chars con el problema o solicitud específica>","ticket_summary":"<resumen 2-3 oraciones: quién es el cliente, cuál es el problema/solicitud, qué acción requiere el equipo>","client_name":"<nombre del cliente o null>","client_email":"<email o null>","client_phone":"<teléfono real o null>","client_identification":"<cédula, NIT u otro documento o null>"}`

  const userContent = `DATOS DEL CONTACTO REGISTRADOS: ${contactInfo}\n\nHISTORIAL DE LA CONVERSACIÓN:\n${transcript}`

  const result = await callLLM(
    [{ role: 'user', content: userContent }],
    { workspaceId, systemPrompt, provider: bot.provider || undefined, model: bot.model || undefined }
  )

  const raw = result.content.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  return JSON.parse(raw)
}

const SYSTEM_RULES =
  `INSTRUCCIONES:\n` +
  `- Sigue el documento de conocimiento exactamente: identifica el paso actual en el historial y ejecuta SOLO el siguiente paso. No combines pasos.\n` +
  `- Secciones [Excel]: contienen datos de clientes/facturas. Busca por cédula, NIT o número de cliente cuando el procedimiento lo indique.\n` +
  `- Responde en tus propias palabras, nunca copies texto crudo del contexto.\n` +
  `- No inventes precios, fechas ni datos que no estén en el documento.\n` +
  `- SEÑALES: cuando el documento indique una de estas palabras en corchetes en ese punto exacto del protocolo, cópiala al final de tu respuesta (solo si la conversación llegó a ese paso):\n` +
  `  [cerrar] [escalar] [escalar:Dept] [ticket:Dept] [lead]\n` +
  `  Nunca emitas una señal si el paso previo no se completó.\n` +
  `- NUNCA menciones ni inventes números de ticket; el sistema los envía automáticamente.\n` +
  `- Si el usuario hace una pregunta específica que no puedes responder con certeza, indica que lo conectarás con un asesor e incluye [escalar] al final. No inventes información.`

function buildAgentSystemPrompt(bot, workspace, knowledgeContext, turns = 1, hasExistingBotMessages = false, returnStructured = false) {
  const workspaceName = workspace?.name || 'la empresa'
  const botName = bot.name || 'Asistente'
  const customPrompt = (bot.system_prompt || '').replace(/\{\{workspace_name\}\}/g, workspaceName)

  const persona = customPrompt
    ? customPrompt
    : `Eres ${botName}, asistente virtual de ${workspaceName}. Eres amable, natural y cercano. Respondes en español.`

  // Suprimir saludo/presentación si la conversación ya tiene mensajes previos del bot,
  // incluso en el turno 1 (cuando el cliente abre con "Hola" después del mensaje de bienvenida).
  const ongoingInstruction = (turns > 1 || hasExistingBotMessages)
    ? `\n\nEsta conversación ya está en curso. NO te presentes de nuevo ni saludes al inicio de tu respuesta. Continúa directamente con lo que el cliente necesita, como si ya llevaras varios mensajes hablando con esta persona.`
    : ''

  // Sección 1 — Identidad
  const part1 = persona + ongoingInstruction

  // Sección 2 — Contexto (solo si hay knowledgeContext)
  const part2 = knowledgeContext
    ? `CONTEXTO DEL DOCUMENTO:\n${knowledgeContext}`
    : null

  // Sección 3 — Reglas del sistema (siempre presente)
  const part3 = SYSTEM_RULES

  const parts = [part1]
  if (part2) parts.push(part2)
  parts.push(part3)

  if (returnStructured) {
    return {
      section1: part1,
      section2: part2 || null,
      section3: part3,
      full_prompt: parts.join('\n\n---\n\n'),
    }
  }

  return parts.join('\n\n---\n\n')
}

function buildMessageHistory(history, currentMessage) {
  const messages = []
  for (const msg of history) {
    if (msg.sender_type === 'contact') {
      messages.push({ role: 'user', content: msg.content })
    } else if (msg.sender_type === 'bot') {
      messages.push({ role: 'assistant', content: msg.content })
    }
  }
  // El contexto KB ya está en el system prompt — NO inyectar de nuevo aquí
  // (doble inyección era la causa principal del gasto excesivo de tokens)
  messages.push({ role: 'user', content: currentMessage })
  return messages
}

// ─────────────────────────────────────────────────────────────────────────────
// Detección de intención conversacional
// ─────────────────────────────────────────────────────────────────────────────

const CONVERSATIONAL_PATTERNS = [
  // Saludos
  /^(hola|hello|hi+|hey|buenas?|buen(os|as)\s+(días?|tardes?|noches?)|qué\s+tal|cómo\s+estás?|como\s+estas?)/i,
  // Despedidas
  /^(adiós|adios|chao|chau|hasta\s+(luego|pronto|mañana)|bye|nos\s+vemos)/i,
  // Preguntas sobre identidad del bot
  /¿?(eres\s+(un\s+)?(bot|robot|humano?|persona|asistente|ia|inteligencia)|quién\s+eres|qué\s+eres|cómo\s+te\s+llamas|cuál\s+es\s+tu\s+nombre)/i,
  // Preguntas de estado
  /^¿?(cómo\s+estás?|como\s+estas?|todo\s+bien|qué\s+hay)/i,
]

/**
 * Detecta si un mensaje es puramente conversacional (saludo, despedida,
 * identidad del bot) y por tanto NO necesita la base de conocimiento.
 *
 * NOTA: Las afirmaciones/negaciones cortas ("sí", "no", "listo", "ok") y
 * agradecimientos NO se tratan como conversacionales porque en procedimientos
 * multi-paso son respuestas a preguntas del protocolo y necesitan el contexto.
 */
function isConversationalMessage(text, turns = 1) {
  const trimmed = text.trim()
  // Once a procedure is underway (turn ≥ 2) always load context — short answers like
  // "sí"/"no" are procedure responses, not casual chat.
  if (turns > 1) return false
  // On the first turn only: short messages and greeting patterns skip context injection.
  if (trimmed.length <= 5) return true
  return CONVERSATIONAL_PATTERNS.some(p => p.test(trimmed))
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function sendBotMessage({ workspaceId, conversationId, content, options = [], botId, io, aiMeta }) {
  let botName = null
  if (botId) {
    try {
      const bot = await BotAgent.findById(botId).select('name').lean()
      botName = bot?.name || null
    } catch {}
  }

  const { message } = await msgService.createMessage({
    workspaceId,
    conversationId,
    senderType: 'bot',
    type: 'text',
    content,
    aiMeta: {
      ...aiMeta,
      bot_id: botId?.toString(),
      bot_name: botName,
      quick_replies: options,  // etiquetas de opciones → el widget las muestra como botones
    },
  })

  if (io) {
    io.to(`conv:${conversationId}`).emit('typing:stop')
    io.to(`conv:${conversationId}`).emit('new:message', message)
    io.to(`workspace:${workspaceId}`).emit('new:message', { conversationId, message })
  }

  // Entregar el mensaje al canal externo (WhatsApp, Telegram, SMS, LINE, Baileys, etc.)
  // Para web_widget y api, sendToChannel es no-op (se entrega via WebSocket).
  setImmediate(async () => {
    try {
      const conv    = await Conversation.findById(conversationId).select('channel_id contact_id').lean()
      if (!conv) return
      const channel = await Channel.findById(conv.channel_id).lean()
      if (!channel || channel.type === 'web_widget' || channel.type === 'api') return

      const contact = await Contact.findById(conv.contact_id).select('channel_ref').lean()
      if (!contact?.channel_ref) return

      // Para canales externos, incluir las opciones del menú como lista numerada en el texto
      let externalContent = content
      if (options && options.length > 0) {
        const optionsList = options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')
        externalContent = `${content}\n\n${optionsList}`
      }

      await channelService.sendToChannel(channel, contact.channel_ref, { content: externalContent, type: 'text' }, conversationId)
    } catch (err) {
      logger.warn({ err: err.message, conversationId }, '[Bot] No se pudo entregar mensaje al canal externo')
    }
  })

  return message
}

/**
 * Extrae el mensaje de bienvenida del system_prompt si existe la directiva:
 *   BIENVENIDA: Hola, soy ...
 */
function extractWelcome(systemPrompt) {
  if (!systemPrompt) return null
  const match = systemPrompt.match(/BIENVENIDA:\s*(.+)/i)
  return match?.[1]?.trim() || null
}

module.exports = { startBotFlow, handleMessage, SYSTEM_RULES, buildAgentSystemPrompt }
