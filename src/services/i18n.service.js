'use strict';

const { getRedis } = require('../db/redis');
const Workspace = require('../db/models/workspace');

const DEFAULTS = {
  transfer_to_agent: 'Entendido. Te estoy conectando con un agente ahora mismo.',
  max_turns_reached: 'Te estoy conectando con un agente que podrá ayudarte mejor.',
  collect_name_error: 'No reconocí ese nombre. Por favor escribe tu nombre completo.',
  collect_email_error: 'Ese correo no parece válido. Por favor ingresa un correo como ejemplo@dominio.com',
  collect_phone_error: 'Ese número no parece válido. Por favor ingresa tu número de teléfono.',
  collect_id_error: 'Ese número de documento no parece válido. Por favor ingresa solo dígitos.',
  erp_customer_not_found: 'No encontré información con ese documento en nuestro sistema. ¿Deseas hablar con un asesor?',
  ticket_created: 'Tu solicitud ha sido registrada con el número {{ticket}}. Un agente la revisará pronto.',
  out_of_hours: 'En este momento estamos fuera de horario de atención. Te responderemos pronto.',
  no_agents_available: 'No hay agentes disponibles en este momento. Por favor espera.',
};

function interpolate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match;
  });
}

async function getBotMessage(workspaceId, key, vars = {}) {
  vars = vars || {}
  if (!(key in DEFAULTS)) return '';

  const cacheKey = `ws:bot_messages:${String(workspaceId)}`;
  let botMessages = null;

  try {
    const redis = getRedis();
    const cached = await redis.get(cacheKey);

    if (cached) {
      try {
        botMessages = JSON.parse(cached);
      } catch (_parseErr) {
        console.warn('[i18n.service] caché Redis corrupta, refetching desde MongoDB');
        botMessages = null;
      }
    }

    if (!botMessages) {
      const workspace = await Workspace.findById(workspaceId)
        .select('settings.bot_messages')
        .lean();

      botMessages = workspace?.settings?.bot_messages ?? {};
      await redis.set(cacheKey, JSON.stringify(botMessages), 'EX', 300);
    }
  } catch (err) {
    console.error('[i18n.service] Error fetching bot messages:', err);
    return interpolate(DEFAULTS[key] ?? '', vars);
  }

  const custom = botMessages?.[key];
  if (custom != null && custom !== '') {
    return interpolate(custom, vars);
  }

  return interpolate(DEFAULTS[key], vars);
}

module.exports = { getBotMessage };
