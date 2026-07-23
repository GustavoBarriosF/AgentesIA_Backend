'use strict'

/**
 * Decide si el mensaje lo atiende el bot o va a la cola de agentes.
 * Retorna: { handler: 'bot' | 'queue', reason }
 *
 * Regla: el bot SIEMPRE atiende primero; los agentes son el respaldo cuando el bot escala.
 */
async function decideHandler(workspace, conversation) {
  if (!workspace || !workspace.settings) {
    return { handler: 'bot', reason: 'invalid_workspace' }
  }

  const settings = workspace.settings

  // 1. Bot deshabilitado -> directo a cola
  if (!settings.bot_enabled) {
    return { handler: 'queue', reason: 'bot_disabled' }
  }

  // 2. Fuera de horario de atencion -> bot atiende
  if (settings.business_hours?.enabled) {
    const inHours = isInBusinessHours(settings.business_hours, settings.business_hours?.timezone)
    if (!inHours) {
      return { handler: 'bot', reason: 'out_of_hours' }
    }
  }

  // 3. La conversacion ya supero el limite de turnos de bot -> escalar a cola
  if ((conversation.bot_turns ?? 0) >= (settings.max_bot_turns || 5)) {
    return { handler: 'queue', reason: 'max_bot_turns_reached' }
  }

  // 4. Default -> bot atiende
  return { handler: 'bot', reason: 'default' }
}

function isInBusinessHours(businessHours, timezone) {
  const now = timezone
    ? new Date(new Date().toLocaleString('en-US', { timeZone: timezone }))
    : new Date()
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
  const day = days[now.getDay()]
  const schedule = businessHours.schedule

  if (!schedule || !schedule.get) return true // Si no hay schedule configurado, siempre abierto

  const dayConfig = schedule.get ? schedule.get(day) : schedule[day]
  if (!dayConfig || !dayConfig.enabled) return false

  const [openH, openM] = dayConfig.open.split(':').map(Number)
  const [closeH, closeM] = dayConfig.close.split(':').map(Number)
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const openMinutes = openH * 60 + openM
  const closeMinutes = closeH * 60 + closeM

  return currentMinutes >= openMinutes && currentMinutes < closeMinutes
}

module.exports = { decideHandler }
