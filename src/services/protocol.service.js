const Conversation = require('../db/models/conversation')
const logger = require('../utils/logger')

/**
 * Initializes the protocol state on a conversation.
 * @param {string} conversationId
 * @param {string} protocolId
 */
async function initProtocol(conversationId, protocolId) {
  await Conversation.findByIdAndUpdate(conversationId, {
    active_protocol_id: protocolId,
    active_protocol_step: 1,
    protocol_step_turns: 0,
    protocol_completed: false,
  })
  logger.info(`Protocol ${protocolId} initialized for conversation ${conversationId}`)
}

/**
 * Builds the context string to inject into the LLM for the current protocol step.
 * @param {object} conversation - Conversation object with active_protocol_step
 * @param {object} protocol - KnowledgeItem with protocol_steps array and title
 * @returns {string}
 */
function getCurrentStepContext(conversation, protocol) {
  const sortedSteps = [...protocol.protocol_steps].sort((a, b) => a.step_number - b.step_number)
  const total = sortedSteps.length
  const currentStep = sortedSteps.find(s => s.step_number === conversation.active_protocol_step)

  if (!currentStep) {
    logger.warn(`Step ${conversation.active_protocol_step} not found in protocol ${protocol._id}`)
    return ''
  }

  const nextStep = sortedSteps.find(s => s.step_number === conversation.active_protocol_step + 1)

  let context = `=== PROTOCOLO DE ATENCIÓN: ${protocol.title} ===\n\n`
  context += `PASO ACTUAL (${currentStep.step_number}/${total}): ${currentStep.title}\n\n`
  context += `${currentStep.instructions}\n\n`

  if (currentStep.completion_signal) {
    context += `Cuando hayas completado este paso, incluye exactamente esta señal al final de tu respuesta: ${currentStep.completion_signal}`
  } else {
    context += `Este paso se completa automáticamente. Continúa al siguiente cuando el cliente responda.`
  }

  if (nextStep) {
    context += `\n\nSIGUIENTE PASO (${nextStep.step_number}/${total}): ${nextStep.title}\n`
    context += `(Para que sepas hacia dónde vas, pero enfócate en completar el paso actual primero.)`
  }

  return context
}

/**
 * Processes the LLM response and determines if the current step was completed.
 * Updates conversation state accordingly.
 * @param {object} conversation - Conversation object
 * @param {object} protocol - KnowledgeItem
 * @param {string} llmResponse - Full LLM response string
 * @returns {Promise<{stepCompleted: boolean, cleanResponse: string, shouldEscalate: boolean, reason?: string}>}
 */
async function processStepCompletion(conversation, protocol, llmResponse) {
  const currentStep = protocol.protocol_steps.find(
    s => s.step_number === conversation.active_protocol_step
  )

  if (!currentStep) {
    logger.warn(`Step ${conversation.active_protocol_step} not found during processStepCompletion`)
    return { stepCompleted: false, cleanResponse: llmResponse, shouldEscalate: true, reason: 'step_not_found' }
  }

  const hasSignal = currentStep.completion_signal != null && currentStep.completion_signal !== ''
  let stepCompleted = false
  let cleanResponse = llmResponse

  if (!hasSignal) {
    // Auto-complete
    stepCompleted = true
  } else {
    const signalRegex = new RegExp(
      currentStep.completion_signal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'i'
    )
    if (signalRegex.test(llmResponse)) {
      stepCompleted = true
      cleanResponse = llmResponse.replace(signalRegex, '').trim()
    }
  }

  if (stepCompleted) {
    const sortedSteps = protocol.protocol_steps.slice().sort((a, b) => a.step_number - b.step_number)
    const currentIdx = sortedSteps.findIndex(s => s.step_number === conversation.active_protocol_step)
    const nextStep = sortedSteps[currentIdx + 1]
    const nextStepNumber = nextStep ? nextStep.step_number : conversation.active_protocol_step + 1

    const updateResult = await Conversation.findOneAndUpdate(
      { _id: conversation._id, active_protocol_step: conversation.active_protocol_step },
      { $set: { active_protocol_step: nextStepNumber, protocol_step_turns: 0 } },
      { new: true }
    )
    // Si otro proceso ya avanzó el paso, ignorar esta respuesta
    if (!updateResult) {
      return { stepCompleted: false, cleanResponse: llmResponse, shouldEscalate: false, duplicateDetected: true }
    }
    logger.info(
      `Protocol step ${conversation.active_protocol_step} completed for conversation ${conversation._id}`
    )
    return { stepCompleted: true, cleanResponse, shouldEscalate: false }
  }

  // Step not completed — increment turn counter
  const newTurns = (conversation.protocol_step_turns || 0) + 1
  await Conversation.findOneAndUpdate(
    { _id: conversation._id, active_protocol_step: conversation.active_protocol_step },
    { $inc: { protocol_step_turns: 1 } }
  )

  if (currentStep.max_turns_in_step != null && newTurns >= currentStep.max_turns_in_step) {
    logger.warn(
      `Step ${currentStep.step_number} timed out after ${newTurns} turns for conversation ${conversation._id}`
    )
    return { stepCompleted: false, cleanResponse: llmResponse, shouldEscalate: true, reason: 'step_timeout' }
  }

  return { stepCompleted: false, cleanResponse: llmResponse, shouldEscalate: false }
}

/**
 * Returns true if the conversation has advanced past the last protocol step.
 * @param {object} conversation
 * @param {object} protocol
 * @returns {boolean}
 */
function isProtocolComplete(conversation, protocol) {
  if (!protocol.protocol_steps || protocol.protocol_steps.length === 0) return false
  const maxStep = Math.max(...protocol.protocol_steps.map(s => s.step_number))
  return conversation.active_protocol_step > maxStep
}

module.exports = { initProtocol, getCurrentStepContext, processStepCompletion, isProtocolComplete }
