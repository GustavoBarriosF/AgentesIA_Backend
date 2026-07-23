'use strict'

const crypto = require('crypto')
const Channel = require('../../db/models/channel')
const contactService = require('../../services/contact.service')
const convService = require('../../services/conversation.service')
const msgService = require('../../services/message.service')
const botService = require('../../services/bot.service')
const routingService = require('../../services/routing.service')
const Workspace = require('../../db/models/workspace')
const Conversation = require('../../db/models/conversation')
const { processIncomingMessage } = require('../../services/incoming-message.service')
const { parseSendGrid, parseMailgun, parsePostmark, processInboundEmail } = require('../../services/email-parser.service')
const logger = require('../../utils/logger')

async function webhookRoutes(fastify) {
  // ─── WhatsApp ────────────────────────────────────────────────────────────────

  // GET /webhooks/whatsapp - Verificacion de webhook por Meta
  // Meta envia el hub.verify_token que configuramos al registrar el webhook.
  // Cada canal tiene su propio verify_token en channel.config.verify_token,
  // por lo que buscamos el canal que coincida.
  fastify.get('/whatsapp', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Verificación webhook WhatsApp (Meta)',
      description: [
        'Endpoint de verificación que Meta llama una sola vez al registrar el webhook.',
        '',
        '**Meta envía:**',
        '- `hub.mode=subscribe`',
        '- `hub.verify_token` — debe coincidir con `channel.config.verify_token` del canal',
        '- `hub.challenge` — debe retornarse tal cual para confirmar la verificación',
        '',
        'En esta plataforma SaaS, el `verify_token` es **por canal** (no global).',
        'Cada cliente configura el suyo al crear el canal WhatsApp.',
      ].join('\n'),
      querystring: {
        type: 'object',
        properties: {
          'hub.mode':         { type: 'string', enum: ['subscribe'], description: 'Siempre "subscribe"' },
          'hub.verify_token': { type: 'string', description: 'Token configurado en el canal del cliente' },
          'hub.challenge':    { type: 'string', description: 'String aleatorio que debe retornarse' },
        },
      },
      response: {
        200: { description: 'Verificación exitosa — retorna hub.challenge', type: 'string' },
        403: { description: 'Token no encontrado en ningún canal WhatsApp activo', type: 'string' },
      },
    },
  }, async (request, reply) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = request.query
    if (mode !== 'subscribe' || !token) {
      return reply.code(403).send('Forbidden')
    }

    // Buscar el canal WhatsApp que tenga este verify_token
    const channel = await Channel.findOne({ type: 'whatsapp', 'config.verify_token': token, active: true })
    if (!channel) {
      logger.warn({ token }, 'verify_token no encontrado en ningun canal WhatsApp')
      return reply.code(403).send('Forbidden')
    }

    return reply.send(challenge)
  })

  // POST /webhooks/whatsapp - Mensajes entrantes de WhatsApp
  // La firma HMAC usa el app_secret de la Meta App del cliente, que esta en
  // channel.config.app_secret. Primero extraemos el phone_number_id del payload
  // para identificar el canal, luego verificamos la firma con su app_secret.
  fastify.post('/whatsapp', {
    config: { rawBody: true },
    schema: {
      tags: ['Webhooks'],
      summary: 'Mensajes entrantes de WhatsApp',
      description: [
        'Meta envía aquí todos los mensajes, eventos de estado y notificaciones de los números registrados.',
        '',
        '**Flujo interno:**',
        '1. Extrae `phone_number_id` del payload para identificar el canal del cliente',
        '2. Verifica firma HMAC-SHA256 con `channel.config.app_secret`',
        '3. Responde `200 OK` inmediatamente (Meta reintenta si no recibe respuesta en < 20s)',
        '4. Procesa el mensaje en background (crea contacto, conversación, llama al bot IA)',
        '',
        '⚠️ **No llamar manualmente** — es un endpoint para Meta Cloud API únicamente.',
      ].join('\n'),
      headers: {
        type: 'object',
        properties: {
          'x-hub-signature-256': {
            type: 'string',
            description: 'Firma HMAC-SHA256 del body generada por Meta con el app_secret del cliente',
          },
        },
      },
      body: {
        type: 'object',
        description: 'Payload de Meta Cloud API (entry → changes → value)',
      },
      response: {
        200: { description: 'Recibido correctamente', type: 'string' },
        401: { description: 'Firma HMAC inválida', type: 'string' },
      },
    },
  }, async (request, reply) => {
    const body = request.body
    const phoneNumberId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id

    if (!phoneNumberId) {
      return reply.code(200).send('OK') // Ignorar payloads sin phone_number_id (ej: status updates)
    }

    // Buscar el canal por phone_number_id
    const channel = await Channel.findOne({
      type: 'whatsapp',
      'config.phone_number_id': phoneNumberId,
      active: true,
    })

    if (!channel) {
      logger.warn({ phoneNumberId }, 'Canal WhatsApp no encontrado para este phone_number_id')
      return reply.code(200).send('OK') // No revelar que no existe
    }

    // Verificar firma HMAC con el app_secret del canal del cliente
    const signature = request.headers['x-hub-signature-256']
    const appSecret = channel.config.app_secret
    if (signature && appSecret) {
      const expected = 'sha256=' + crypto
        .createHmac('sha256', appSecret)
        .update(request.rawBody || JSON.stringify(body))
        .digest('hex')
      if (signature !== expected) {
        logger.warn({ phoneNumberId, workspaceId: channel.workspace_id }, 'Firma HMAC de WhatsApp invalida')
        return reply.code(401).send('Unauthorized')
      }
    } else if (!appSecret) {
      logger.warn({ phoneNumberId }, 'Canal sin app_secret configurado, omitiendo verificacion HMAC')
    }

    // Responder inmediatamente — Meta reintenta si no recibe 200 en < 20s
    reply.code(200).send('OK')

    // Procesar en background pasando el canal ya resuelto
    setImmediate(() => processWhatsAppPayload(fastify, body, channel).catch(err =>
      logger.error({ err }, 'Error procesando webhook WhatsApp')
    ))
  })

  // ─── Meta (Facebook Messenger + Instagram DM) ────────────────────────────────
  //
  // Un solo par de endpoints maneja AMBOS canales:
  //   GET  /webhooks/meta  → verificación del webhook en Meta Developers
  //   POST /webhooks/meta  → mensajes entrantes de Messenger e Instagram DM
  //
  // Meta distingue el origen con el campo `object`:
  //   "page"      → Facebook Messenger
  //   "instagram" → Instagram DM
  //
  // Identificación del canal:
  //   entry[0].id = Page ID (Messenger) o IG Account ID (Instagram)
  //   Se busca en BD: facebook_messenger con config.page_id
  //                   instagram_dm      con config.ig_account_id
  //
  // Cada workspace configura sus propias credenciales (multi-tenant SaaS).

  fastify.get('/meta', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Verificación webhook Meta (Messenger + Instagram)',
      description: [
        'Endpoint de verificación que Meta llama al registrar el webhook.',
        '',
        'Meta envía `hub.verify_token` que debe coincidir con `channel.config.verify_token`',
        'de algún canal `facebook_messenger` o `instagram_dm` activo.',
        '',
        'En este SaaS cada canal tiene su propio `verify_token` — no hay token global.',
      ].join('\n'),
      querystring: {
        type: 'object',
        properties: {
          'hub.mode':         { type: 'string' },
          'hub.verify_token': { type: 'string' },
          'hub.challenge':    { type: 'string' },
        },
      },
      response: {
        200: { type: 'string' },
        403: { type: 'string' },
      },
    },
  }, async (request, reply) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = request.query

    if (mode !== 'subscribe' || !token) {
      return reply.code(403).send('Forbidden')
    }

    // Buscar en ambos tipos de canal Meta
    const channel = await Channel.findOne({
      type:                   { $in: ['facebook_messenger', 'instagram_dm'] },
      'config.verify_token':  token,
      active:                 true,
    })

    if (!channel) {
      logger.warn({ token }, '[Meta] verify_token no encontrado en ningún canal activo')
      return reply.code(403).send('Forbidden')
    }

    logger.info({ channelId: channel._id, type: channel.type }, '[Meta] Webhook verificado')
    return reply.send(challenge)
  })

  fastify.post('/meta', {
    config: { rawBody: true },
    schema: {
      tags: ['Webhooks'],
      summary: 'Mensajes entrantes Meta (Messenger + Instagram DM)',
      description: [
        'Recibe mensajes de Facebook Messenger e Instagram DM.',
        '',
        '**Identificación del canal:**',
        '- `object: "page"` → Messenger → busca canal por `config.page_id`',
        '- `object: "instagram"` → Instagram DM → busca por `config.ig_account_id`',
        '',
        'Verifica firma HMAC-SHA256 con `channel.config.app_secret` del cliente.',
        'Responde 200 OK inmediatamente y procesa en background.',
        '',
        '⚠️ Solo para Meta Platform — no llamar manualmente.',
      ].join('\n'),
      body:     { type: 'object', description: 'Payload de Meta Messenger Platform' },
      response: {
        200: { type: 'string' },
        401: { type: 'string' },
      },
    },
  }, async (request, reply) => {
    const body   = request.body
    const object = body?.object // "page" o "instagram"

    if (!['page', 'instagram'].includes(object)) {
      return reply.code(200).send('OK') // Ignorar otros objetos (ej: leadgen, feed)
    }

    const entryId = body?.entry?.[0]?.id
    if (!entryId) return reply.code(200).send('OK')

    // Identificar canal según tipo de objeto
    let channel = null
    if (object === 'page') {
      channel = await Channel.findOne({
        type:              'facebook_messenger',
        'config.page_id':  entryId,
        active:            true,
      })
    } else {
      channel = await Channel.findOne({
        type:                    'instagram_dm',
        'config.ig_account_id':  entryId,
        active:                  true,
      })
    }

    if (!channel) {
      logger.warn({ object, entryId }, '[Meta] Canal no encontrado para este entry ID')
      return reply.code(200).send('OK') // No revelar que no existe
    }

    // Verificar firma HMAC-SHA256
    const signature = request.headers['x-hub-signature-256']
    const appSecret = channel.config.app_secret
    if (signature && appSecret) {
      const expected = 'sha256=' + crypto
        .createHmac('sha256', appSecret)
        .update(request.rawBody || JSON.stringify(body))
        .digest('hex')
      if (signature !== expected) {
        logger.warn({ entryId, workspaceId: channel.workspace_id }, '[Meta] Firma HMAC inválida')
        return reply.code(401).send('Unauthorized')
      }
    }

    // Responder 200 inmediatamente — Meta reintenta si no recibe respuesta en < 20s
    reply.code(200).send('OK')

    // Procesar en background
    setImmediate(() => processMetaPayload(fastify, body, channel).catch(err =>
      logger.error({ err: err.message }, '[Meta] Error procesando webhook')
    ))
  })

  // ─── Telegram ────────────────────────────────────────────────────────────────

  // POST /webhooks/telegram/:botToken - Mensajes entrantes de Telegram
  fastify.post('/telegram/:botToken', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Mensajes entrantes de Telegram',
      description: [
        'Telegram envía updates del bot a este endpoint.',
        'Cada bot tiene su propio URL de webhook: `/webhooks/telegram/{botToken}`.',
        '',
        '**Flujo interno:**',
        '1. Busca el canal por `botToken`',
        '2. Responde `200 OK` inmediatamente',
        '3. Procesa en background (crea contacto, conversación, bot IA)',
        '',
        '⚠️ **No llamar manualmente** — es un endpoint para la API de Telegram.',
      ].join('\n'),
      params: {
        type: 'object',
        required: ['botToken'],
        properties: {
          botToken: { type: 'string', description: 'Token del bot de Telegram (ej: 123456:ABCxxx)' },
        },
      },
      body: {
        type: 'object',
        description: 'Update de Telegram (message, callback_query, etc.)',
      },
      response: {
        200: { description: 'Recibido correctamente', type: 'string' },
      },
    },
  }, async (request, reply) => {
    // Responder inmediatamente
    reply.code(200).send('OK')

    setImmediate(() => processTelegramPayload(fastify, request.params.botToken, request.body).catch(err =>
      logger.error({ err }, 'Error procesando webhook Telegram')
    ))
  })

// El canal ya viene resuelto desde el handler HTTP (evita segunda query a DB)
async function processWhatsAppPayload(fastify, body, channel) {
  const entry = body?.entry?.[0]
  const changes = entry?.changes?.[0]
  const value = changes?.value

  if (!value?.messages) return

  for (const msg of value.messages) {
    if (msg.type !== 'text') continue // TODO: soporte multimedia

    const senderPhone = msg.from
    const text = msg.text?.body || ''
    const channelMessageId = msg.id

    const senderInfo = value.contacts?.find(c => c.wa_id === senderPhone)
    const senderName = senderInfo?.profile?.name || senderPhone

    await processIncomingMessage(fastify, {
      workspaceId: channel.workspace_id.toString(),
      channelId: channel._id.toString(),
      channelRef: senderPhone,
      channelType: 'whatsapp',
      name: senderName,
      text,
      channelMessageId,
    })
  }
}

async function processTelegramPayload(fastify, botToken, body) {
  const message = body?.message
  if (!message) return

  const channel = await Channel.findOne({ type: 'telegram', 'config.bot_token': botToken })
  if (!channel) {
    logger.warn({ botToken: botToken.slice(0, 10) + '...' }, 'Canal Telegram no encontrado')
    return
  }

  const chatId = message.chat?.id?.toString()
  const text = message.text || ''
  const channelMessageId = message.message_id?.toString()
  const name = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || 'Usuario'

  await processIncomingMessage(fastify, {
    workspaceId: channel.workspace_id.toString(),
    channelId: channel._id.toString(),
    channelRef: chatId,
    channelType: 'telegram',
    name,
    text,
    channelMessageId,
  })
}

/**
 * Procesa el payload de Meta Messenger Platform (Messenger e Instagram DM).
 *
 * Estructura del payload:
 *   object: "page" | "instagram"
 *   entry[].messaging[].sender.id     → PSID (Messenger) o IGSID (Instagram)
 *   entry[].messaging[].message.text  → Texto del mensaje
 *   entry[].messaging[].message.mid   → ID único del mensaje (deduplicación)
 *   entry[].messaging[].attachments[] → Adjuntos (imagen, audio, video, etc.)
 *   entry[].messaging[].postback      → Postback de botón
 */
async function processMetaPayload(fastify, body, channel) {
  const { getMessengerUserName, getInstagramUserName } = require('../../services/meta.service')
  const isInstagram = channel.type === 'instagram_dm'
  const channelType = channel.type

  for (const entry of (body.entry || [])) {
    for (const event of (entry.messaging || [])) {
      // Ignorar echoes (mensajes enviados por la página a sí misma)
      if (event.message?.is_echo) continue

      // Ignorar eventos sin mensaje ni postback
      if (!event.message && !event.postback) continue

      const senderId        = event.sender?.id
      const channelMessageId = event.message?.mid || null
      if (!senderId) continue

      // Extraer texto: del mensaje o del postback
      let text = ''
      if (event.message?.text) {
        text = event.message.text
      } else if (event.postback?.title) {
        text = event.postback.title
      } else if (event.message?.attachments?.length) {
        // Adjunto sin texto — guardar como mensaje de tipo attachment
        // Por ahora usamos la URL del primer adjunto como contenido
        const att = event.message.attachments[0]
        text = att.payload?.url || `[${att.type}]`
      }

      if (!text) continue

      // Obtener nombre del usuario (intento con API de Meta, fallback al ID)
      let name = senderId
      try {
        if (isInstagram) {
          name = await getInstagramUserName(senderId, channel.config.access_token) || senderId
        } else {
          name = await getMessengerUserName(senderId, channel.config.access_token) || senderId
        }
      } catch {
        // No bloquear el flujo si falla la consulta de nombre
      }

      await processIncomingMessage(fastify, {
        workspaceId:      channel.workspace_id.toString(),
        channelId:        channel._id.toString(),
        channelRef:       senderId,
        channelType,
        name,
        text,
        channelMessageId,
        metadata: {
          meta_object: body.object,
          page_id:     entry.id,
        },
      })
    }
  }
}

// processIncomingMessage viene del servicio compartido (incoming-message.service.js)

  // ─── Pagos (plugin separado) ─────────────────────────────────────────────────
  fastify.register(require('./payments'), { prefix: '/payments' })

  // ─── Email: SendGrid Inbound Parse ───────────────────────────────────────────
  //
  // POST /webhooks/email/sendgrid
  // Configura esta URL en SendGrid → Settings → Inbound Parse → Add Host & URL.
  // SendGrid envía multipart/form-data con los campos del email.
  // La ruta al canal se hace por el campo `to` (inbound_address del canal).

  fastify.post('/email/sendgrid', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Email entrante — SendGrid Inbound Parse',
      description: 'SendGrid envía el email como multipart/form-data. Configura esta URL en Settings → Inbound Parse.',
      response: { 200: { type: 'string' } },
    },
  }, async (request, reply) => {
    reply.code(200).send('OK')
    setImmediate(async () => {
      try {
        const parsed  = parseSendGrid(request.body || {})
        const channel = await Channel.findOne({
          type:   'email',
          active: true,
          'config.inbound_address': { $regex: new RegExp(extractLocalPart(parsed.to), 'i') },
        })
        if (!channel) {
          logger.warn({ to: parsed.to }, '[Email/SendGrid] No se encontró canal para este destinatario')
          return
        }
        await processIncomingEmail(fastify, parsed, channel)
      } catch (err) {
        logger.error({ err: err.message }, '[Email/SendGrid] Error procesando email entrante')
      }
    })
  })

  // ─── Email: Mailgun Routes ────────────────────────────────────────────────────
  //
  // POST /webhooks/email/mailgun
  // Configura una "Route" en Mailgun que haga forward a esta URL.
  // Mailgun envía multipart/form-data con los campos del email.

  fastify.post('/email/mailgun', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Email entrante — Mailgun Routes',
      description: 'Mailgun envía el email como multipart/form-data. Configura una Route en tu dominio Mailgun que apunte a esta URL.',
      response: { 200: { type: 'string' } },
    },
  }, async (request, reply) => {
    reply.code(200).send('OK')
    setImmediate(async () => {
      try {
        const parsed  = parseMailgun(request.body || {})
        const channel = await Channel.findOne({
          type:   'email',
          active: true,
          'config.inbound_address': { $regex: new RegExp(extractLocalPart(parsed.to), 'i') },
        })
        if (!channel) {
          logger.warn({ to: parsed.to }, '[Email/Mailgun] No se encontró canal para este destinatario')
          return
        }
        await processIncomingEmail(fastify, parsed, channel)
      } catch (err) {
        logger.error({ err: err.message }, '[Email/Mailgun] Error procesando email entrante')
      }
    })
  })

  // ─── SMS: Twilio ─────────────────────────────────────────────────────────────
  //
  // POST /webhooks/sms/twilio
  // Twilio envía mensajes entrantes como form-encoded POST.
  // Se identifica el canal por el número destino (To = nuestro número).
  // Verificación: X-Twilio-Signature (HMAC-SHA1 de URL + params con auth_token).
  // Soporta mensajes multi-segmento (Twilio los concatena) y MMS (NumMedia > 0).

  fastify.post('/sms/twilio', {
    schema: {
      tags: ['Webhooks'],
      summary: 'SMS entrante — Twilio',
      description: [
        'Twilio envía mensajes SMS/MMS entrantes como form-encoded POST.',
        '',
        '**Identificación del canal:** campo `To` (número del cliente).',
        '**Verificación:** `X-Twilio-Signature` HMAC-SHA1.',
        '',
        'Configura esta URL en Twilio Console → Phone Numbers → tu número → Messaging → Webhook.',
      ].join('\n'),
      response: {
        200: { type: 'string', description: 'TwiML response vacío para indicar éxito' },
      },
    },
  }, async (request, reply) => {
    const params = request.body || {}
    const toNumber   = params.To    || ''
    const fromNumber = params.From  || ''
    const body       = params.Body  || ''
    const numMedia   = parseInt(params.NumMedia || '0', 10)

    if (!toNumber) return reply.code(200).send('<?xml version="1.0"?><Response/>')

    // Buscar canal por número de teléfono
    const channel = await Channel.findOne({
      type: 'sms',
      'config.phone_number': toNumber,
      active: true,
    })
    if (!channel) {
      logger.warn({ toNumber }, '[SMS/Twilio] Canal no encontrado para este número')
      return reply.code(200).send('<?xml version="1.0"?><Response/>')
    }

    // Verificar firma Twilio
    const twilioSig = request.headers['x-twilio-signature']
    const authToken = channel.config.auth_token
    if (twilioSig && authToken) {
      const fullUrl = `${process.env.PUBLIC_API_URL || 'http://localhost:3000'}/webhooks/sms/twilio`
      if (!verifyTwilioSignature(authToken, fullUrl, params, twilioSig)) {
        logger.warn({ toNumber }, '[SMS/Twilio] Firma inválida')
        return reply.code(200).send('<?xml version="1.0"?><Response/>') // Twilio espera 200 siempre
      }
    }

    // Responder TwiML vacío inmediatamente
    reply.code(200).type('text/xml').send('<?xml version="1.0"?><Response/>')

    setImmediate(async () => {
      try {
        // MMS: extraer la primera imagen si existe
        let text = body
        let msgType = 'text'
        let mediaUrl = null
        if (numMedia > 0 && params.MediaUrl0) {
          mediaUrl = params.MediaUrl0
          msgType  = 'image'
          if (!text) text = '[Imagen]'
        }

        await processIncomingMessage(fastify, {
          workspaceId:      channel.workspace_id.toString(),
          channelId:        channel._id.toString(),
          channelRef:       fromNumber,
          channelType:      'sms',
          name:             fromNumber, // no hay nombre en SMS
          text,
          channelMessageId: params.MessageSid || null,
          metadata:         { media_url: mediaUrl, msg_type: msgType },
        })
      } catch (err) {
        logger.error({ err: err.message }, '[SMS/Twilio] Error procesando mensaje entrante')
      }
    })
  })

  // ─── SMS: Vonage ─────────────────────────────────────────────────────────────
  //
  // POST /webhooks/sms/vonage
  // Vonage envía mensajes entrantes como JSON o form-encoded.
  // Se identifica el canal por el número destino (to = nuestro número virtual).

  fastify.post('/sms/vonage', {
    schema: {
      tags: ['Webhooks'],
      summary: 'SMS entrante — Vonage',
      description: [
        'Vonage (Nexmo) envía mensajes SMS entrantes a esta URL.',
        '',
        '**Identificación del canal:** campo `to` (número virtual del cliente).',
        'Configura esta URL en Vonage Dashboard → Numbers → tu número → SMS webhook.',
      ].join('\n'),
      body: { type: 'object' },
      response: { 200: { type: 'string' } },
    },
  }, async (request, reply) => {
    reply.code(200).send('OK')

    setImmediate(async () => {
      try {
        const params = request.body || {}
        const toNumber   = params.to      || ''
        const fromNumber = params.msisdn  || ''
        const text       = params.text    || ''
        const messageId  = params.messageId || null

        if (!toNumber || !fromNumber) return

        const channel = await Channel.findOne({
          type: 'sms',
          'config.phone_number': toNumber,
          active: true,
        })
        if (!channel) {
          logger.warn({ toNumber }, '[SMS/Vonage] Canal no encontrado para este número')
          return
        }

        await processIncomingMessage(fastify, {
          workspaceId:      channel.workspace_id.toString(),
          channelId:        channel._id.toString(),
          channelRef:       fromNumber,
          channelType:      'sms',
          name:             fromNumber,
          text,
          channelMessageId: messageId,
        })
      } catch (err) {
        logger.error({ err: err.message }, '[SMS/Vonage] Error procesando mensaje entrante')
      }
    })
  })

  // ─── LINE ────────────────────────────────────────────────────────────────────
  //
  // POST /webhooks/line
  // LINE envía eventos (mensajes, follows, unfollows) a esta URL.
  // Cada cliente configura su propio Channel con su Channel Secret y Access Token.
  // Identificación: verificamos la firma X-Line-Signature con cada canal activo
  //                 hasta encontrar el que coincida.
  // Soporte: text, image, sticker, flex messages.

  fastify.post('/line', {
    config: { rawBody: true },
    schema: {
      tags: ['Webhooks'],
      summary: 'Mensajes entrantes de LINE',
      description: [
        'LINE envía eventos del bot (mensajes, follows, etc.) a esta URL.',
        '',
        '**Configuración:**',
        'En LINE Developers → tu Channel → Messaging API → Webhook URL, pega esta URL.',
        'El canal se identifica verificando `X-Line-Signature` con el `channel_secret` de cada canal activo.',
        '',
        '**Tipos de mensaje soportados:** text, image, sticker (→ [sticker]), flex.',
      ].join('\n'),
      body: { type: 'object' },
      response: { 200: { type: 'string' } },
    },
  }, async (request, reply) => {
    reply.code(200).send('OK')

    setImmediate(async () => {
      try {
        const body    = request.body || {}
        const rawBody = request.rawBody?.toString() || JSON.stringify(body)
        const lineSig = request.headers['x-line-signature']

        if (!body.events?.length) return

        // Encontrar el canal LINE cuyo channel_secret coincida con la firma
        const lineChannels = await Channel.find({ type: 'line', active: true }).lean()
        let channel = null

        for (const ch of lineChannels) {
          const secret = ch.config?.channel_secret
          if (!secret) continue
          const hash = require('crypto')
            .createHmac('sha256', secret)
            .update(rawBody)
            .digest('base64')
          if (hash === lineSig) {
            channel = ch
            break
          }
        }

        if (!channel) {
          logger.warn({ lineSig: lineSig?.slice(0, 10) }, '[LINE] Canal no encontrado para esta firma')
          return
        }

        for (const event of body.events) {
          await processLineEvent(fastify, event, channel).catch(err =>
            logger.error({ err: err.message }, '[LINE] Error procesando evento')
          )
        }
      } catch (err) {
        logger.error({ err: err.message }, '[LINE] Error en webhook')
      }
    })
  })

  // ─── Slack ────────────────────────────────────────────────────────────────────
  //
  // Cada cliente crea su propia Slack App y configura las credenciales en
  // channel.config: { bot_token, signing_secret, team_id }
  //
  // Endpoints:
  //   POST /webhooks/slack/events  → eventos del bot (mensajes, url_verification)
  //   POST /webhooks/slack/slash   → slash command /trivox (form-encoded)
  //
  // Identificación del canal: team_id en el payload coincide con channel.config.team_id
  // Verificación de firma: HMAC-SHA256 de "v0:{timestamp}:{body}" con signing_secret

  // Parser para slash commands (application/x-www-form-urlencoded)
  fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body
    try {
      const parsed = Object.fromEntries(new URLSearchParams(body.toString()))
      done(null, parsed)
    } catch (err) {
      done(err)
    }
  })

  // POST /webhooks/slack/events
  fastify.post('/slack/events', {
    config: { rawBody: true },
    schema: {
      tags: ['Webhooks'],
      summary: 'Eventos entrantes de Slack',
      description: [
        'Slack envía aquí mensajes directos al bot y otros eventos.',
        '',
        '**Tipos de evento manejados:**',
        '- `url_verification`: challenge de verificación inicial',
        '- `event_callback` con `event.type === "message"`: mensaje entrante',
        '',
        'Verifica firma HMAC-SHA256 con `config.signing_secret` del canal.',
      ].join('\n'),
      body: { type: 'object' },
      response: {
        200: { type: 'object', additionalProperties: true },
        401: { type: 'string' },
      },
    },
  }, async (request, reply) => {
    const body = request.body || {}

    // Verificación URL inicial de Slack
    if (body.type === 'url_verification') {
      return reply.send({ challenge: body.challenge })
    }

    if (body.type !== 'event_callback') {
      return reply.send({ ok: true })
    }

    const teamId  = body.team_id
    const channel = await Channel.findOne({ type: 'slack', 'config.team_id': teamId, active: true })

    if (!channel) {
      logger.warn({ teamId }, '[Slack Events] Canal no encontrado para este team_id')
      return reply.send({ ok: true })
    }

    // Verificar firma Slack
    const signingSecret = channel.config.signing_secret
    if (signingSecret) {
      const timestamp = request.headers['x-slack-request-timestamp']
      const slackSig  = request.headers['x-slack-signature']
      const rawBody   = request.rawBody?.toString() || JSON.stringify(body)

      // Rechazar si el timestamp es muy antiguo (> 5 min)
      if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
        return reply.code(401).send('Request too old')
      }

      const expected = 'v0=' + crypto.createHmac('sha256', signingSecret)
        .update(`v0:${timestamp}:${rawBody}`)
        .digest('hex')

      if (slackSig !== expected) {
        logger.warn({ teamId }, '[Slack Events] Firma inválida')
        return reply.code(401).send('Unauthorized')
      }
    }

    // Responder inmediatamente — Slack reintenta si no recibe 200 en 3s
    reply.send({ ok: true })

    setImmediate(() => processSlackEvent(fastify, body, channel).catch(err =>
      logger.error({ err: err.message }, '[Slack Events] Error procesando evento')
    ))
  })

  // POST /webhooks/slack/slash
  // Slash command /trivox — Slack envía form-encoded
  fastify.post('/slack/slash', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Slash command /trivox de Slack',
      description: 'Slack envía el slash command /trivox como form-encoded. Abre una conversación o ticket.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const params = request.body || {}
    const { team_id, user_id, user_name, channel_id, text, command } = params

    // Verificación de firma (igual que events)
    const channel = await Channel.findOne({ type: 'slack', 'config.team_id': team_id, active: true })
    if (!channel) {
      return reply.send({ response_type: 'ephemeral', text: '❌ NexoraChat no está configurado para este workspace.' })
    }

    const signingSecret = channel.config.signing_secret
    if (signingSecret) {
      const timestamp = request.headers['x-slack-request-timestamp']
      const slackSig  = request.headers['x-slack-signature']
      const rawBody   = request.rawBody?.toString() || ''

      if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
        return reply.send({ response_type: 'ephemeral', text: '❌ Request expirado.' })
      }

      const expected = 'v0=' + crypto.createHmac('sha256', signingSecret)
        .update(`v0:${timestamp}:${rawBody}`)
        .digest('hex')

      if (slackSig !== expected) {
        return reply.send({ response_type: 'ephemeral', text: '❌ Firma inválida.' })
      }
    }

    // Responder inmediatamente con mensaje ephemeral
    reply.send({
      response_type: 'ephemeral',
      text: `⏳ Abriendo conversación con soporte... Un agente te atenderá pronto.`,
    })

    // Crear conversación en background
    setImmediate(async () => {
      try {
        const userMessage = text || `Iniciado con ${command}`
        await processIncomingMessage(fastify, {
          workspaceId:      channel.workspace_id.toString(),
          channelId:        channel._id.toString(),
          channelRef:       `slack_dm_${user_id}`,
          channelType:      'slack',
          name:             user_name || user_id,
          text:             userMessage,
          channelMessageId: `slash_${Date.now()}_${user_id}`,
          metadata:         { slack_channel_id: channel_id, slack_user_id: user_id },
        })
      } catch (err) {
        logger.error({ err: err.message }, '[Slack Slash] Error creando conversación')
      }
    })
  })

  // ─── Microsoft Teams ──────────────────────────────────────────────────────────
  //
  // POST /webhooks/teams/messages
  // Azure Bot Framework envía actividades aquí.
  // Identificación: botId del recipient coincide con channel.config.app_id
  // Verificación: header Authorization con token JWT de Microsoft (verificación básica)

  fastify.post('/teams/messages', {
    config: { rawBody: true },
    schema: {
      tags: ['Webhooks'],
      summary: 'Mensajes entrantes de Microsoft Teams',
      description: [
        'Azure Bot Framework envía actividades de Teams a este endpoint.',
        '',
        '**Tipos de actividad manejados:**',
        '- `message`: mensaje de usuario (texto o @mención)',
        '- `conversationUpdate`: bot añadido/eliminado de equipo',
        '',
        'Se identifica el canal por el `recipient.id` (= Azure Bot App ID).',
        'Configura esta URL en el Azure Bot Registration → Messaging endpoint.',
      ].join('\n'),
      headers: {
        type: 'object',
        properties: {
          authorization: { type: 'string', description: 'Bearer token de Microsoft Bot Framework' },
        },
      },
      body: { type: 'object', description: 'Bot Framework Activity' },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (request, reply) => {
    const activity = request.body || {}

    // Identificar canal por bot App ID (recipient.id)
    const botAppId = activity.recipient?.id
    if (!botAppId) return reply.send({ ok: true })

    const channel = await Channel.findOne({ type: 'teams', 'config.app_id': botAppId, active: true })
    if (!channel) {
      logger.warn({ botAppId }, '[Teams] Canal no encontrado para este app_id')
      return reply.send({ ok: true })
    }

    // Solo procesar mensajes de texto y conversationUpdate
    if (!['message', 'conversationUpdate'].includes(activity.type)) {
      return reply.send({ ok: true })
    }

    // Responder 200 inmediatamente — Bot Framework reintenta si no recibe respuesta pronto
    reply.send({ ok: true })

    setImmediate(() => processTeamsActivity(fastify, activity, channel).catch(err =>
      logger.error({ err: err.message }, '[Teams] Error procesando actividad')
    ))
  })

  // ─── Email: Webhook genérico por channelId ───────────────────────────────────
  //
  // POST /webhooks/email/:channelId
  // Endpoint universal para recibir emails entrantes cuando el proveedor soporta
  // URLs de webhook configurables por canal.
  // Verificación opcional por header x-webhook-secret o Authorization.

  fastify.post('/email/:channelId', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Email entrante — webhook genérico por canal',
      description: [
        'Endpoint universal para emails entrantes. Configura esta URL en tu proveedor con el ID del canal.',
        '',
        '**Autenticación opcional:** envía el secret configurado en `channel.config.inbound_webhook_secret`',
        'en el header `x-webhook-secret` o `Authorization`.',
      ].join('\n'),
      params: {
        type: 'object',
        required: ['channelId'],
        properties: {
          channelId: { type: 'string', description: 'ID del canal de tipo email' },
        },
      },
      body: { type: 'object', description: 'Payload del email (campos varían según proveedor)' },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        403: { type: 'string' },
        404: { type: 'string' },
      },
    },
  }, async (request, reply) => {
    const { channelId } = request.params

    // Buscar el canal por ID
    const channel = await Channel.findOne({ _id: channelId, type: 'email', active: true })
    if (!channel) {
      return reply.code(404).send('Not Found')
    }

    // Verificar webhook secret si está configurado (comparación tiempo-constante)
    const expectedSecret = channel.config?.inbound_webhook_secret
    if (expectedSecret) {
      const providedSecret = request.headers['x-webhook-secret'] || request.headers['authorization']
      if (!providedSecret) {
        logger.warn({ channelId }, '[Email/Generic] Secret de webhook no provisto')
        return reply.code(403).send('Forbidden')
      }
      try {
        const expected = Buffer.from(expectedSecret)
        const provided = Buffer.from(providedSecret)
        if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
          logger.warn({ channelId }, '[Email/Generic] Secret de webhook inválido')
          return reply.code(403).send('Forbidden')
        }
      } catch {
        return reply.code(403).send('Forbidden')
      }
    }

    // Procesar en background y responder de inmediato
    setImmediate(async () => {
      try {
        await processInboundEmail(fastify, channel, request.body || {})
      } catch (err) {
        logger.error({ err: err.message, channelId }, '[Email/Generic] Error procesando email entrante')
      }
    })

    return reply.send({ ok: true })
  })

  // ─── Email: Postmark Inbound ──────────────────────────────────────────────────
  //
  // POST /webhooks/email/postmark
  // Configura esta URL como "Inbound webhook URL" en tu Postmark server.
  // Postmark envía JSON.

  fastify.post('/email/postmark', {
    schema: {
      tags: ['Webhooks'],
      summary: 'Email entrante — Postmark Inbound',
      description: 'Postmark envía el email como JSON. Configura esta URL como Inbound Webhook URL en tu Postmark server.',
      response: { 200: { type: 'string' } },
    },
  }, async (request, reply) => {
    reply.code(200).send('OK')
    setImmediate(async () => {
      try {
        const parsed  = parsePostmark(request.body || {})
        const channel = await Channel.findOne({
          type:   'email',
          active: true,
          'config.inbound_address': { $regex: new RegExp(extractLocalPart(parsed.to), 'i') },
        })
        if (!channel) {
          logger.warn({ to: parsed.to }, '[Email/Postmark] No se encontró canal para este destinatario')
          return
        }
        await processIncomingEmail(fastify, parsed, channel)
      } catch (err) {
        logger.error({ err: err.message }, '[Email/Postmark] Error procesando email entrante')
      }
    })
  })
}

/**
 * Verifica la firma de Twilio (HMAC-SHA1).
 * Twilio firma: URL + parámetros POST ordenados alfabéticamente.
 */
function verifyTwilioSignature(authToken, url, params, signature) {
  const sortedKeys = Object.keys(params).sort()
  let toSign = url
  for (const key of sortedKeys) {
    toSign += key + (params[key] || '')
  }
  const expected = crypto.createHmac('sha1', authToken).update(toSign).digest('base64')
  return expected === signature
}

/**
 * Procesa un evento de LINE (message, follow, unfollow, join).
 */
async function processLineEvent(fastify, event, channel) {
  const eventType = event.type

  // follow: el usuario agregó el bot como amigo
  if (eventType === 'follow') {
    logger.info({ channelId: channel._id, userId: event.source?.userId }, '[LINE] Nuevo follow')
    return
  }

  if (eventType !== 'message') return

  const source  = event.source || {}
  const userId  = source.userId
  const msg     = event.message || {}

  if (!userId) return

  let text    = ''
  let msgType = 'text'

  switch (msg.type) {
    case 'text':
      text = msg.text || ''
      break
    case 'image':
      text    = '[Imagen]'
      msgType = 'image'
      break
    case 'sticker':
      text = `[Sticker: ${msg.stickerId || msg.packageId || ''}]`
      break
    case 'audio':
      text    = '[Audio]'
      msgType = 'audio'
      break
    case 'video':
      text    = '[Video]'
      msgType = 'video'
      break
    case 'file':
      text    = `[Archivo: ${msg.fileName || 'archivo'}]`
      msgType = 'file'
      break
    default:
      text = `[${msg.type}]`
  }

  if (!text) return

  await processIncomingMessage(fastify, {
    workspaceId:      channel.workspace_id.toString(),
    channelId:        channel._id.toString(),
    channelRef:       userId,
    channelType:      'line',
    name:             userId, // LINE no expone el nombre en el evento; se puede consultar via Profile API
    text,
    channelMessageId: msg.id || null,
    metadata:         { line_message_type: msg.type, line_reply_token: event.replyToken || null },
  })
}

/**
 * Procesa un evento de Slack (event_callback con event.type === 'message')
 */
async function processSlackEvent(fastify, body, channel) {
  const event = body.event || {}

  // Ignorar mensajes del propio bot (subtype === 'bot_message') o mensajes editados
  if (event.subtype || event.bot_id) return
  if (event.type !== 'message') return

  const slackUserId = event.user
  const text        = event.text || ''
  const slackChannel = event.channel // canal/DM de Slack donde llegó el mensaje

  if (!slackUserId || !text) return

  // Eliminar mención al bot (@bot) del texto si existe
  const cleanText = text.replace(/<@[A-Z0-9]+>/g, '').trim()
  if (!cleanText) return

  await processIncomingMessage(fastify, {
    workspaceId:      channel.workspace_id.toString(),
    channelId:        channel._id.toString(),
    channelRef:       slackChannel, // usar el canal/DM para poder responder
    channelType:      'slack',
    name:             slackUserId, // Slack no da el nombre en el evento; se podría consultar users.info
    text:             cleanText,
    channelMessageId: event.ts, // timestamp es el ID único en Slack
    metadata:         { slack_user_id: slackUserId, slack_channel: slackChannel },
  })
}

/**
 * Procesa una actividad de Microsoft Teams
 */
async function processTeamsActivity(fastify, activity, channel) {
  if (activity.type === 'conversationUpdate') {
    // Bot añadido al equipo — no crear conversación, solo loguear
    const added = activity.membersAdded?.find(m => m.id === activity.recipient?.id)
    if (added) {
      logger.info({ channelId: channel._id }, '[Teams] Bot añadido al equipo/conversación')
    }
    return
  }

  if (activity.type !== 'message') return

  const from    = activity.from || {}
  const text    = activity.text || ''
  const userId  = from.id
  const name    = from.name || userId

  if (!text.trim() || !userId) return

  // Eliminar mención @bot del texto
  const cleanText = text.replace(/<at>[^<]+<\/at>/g, '').trim()
  if (!cleanText) return

  // channelRef: "serviceUrl|||conversationId" para poder responder
  const serviceUrl     = activity.serviceUrl || ''
  const conversationId = activity.conversation?.id || ''
  const channelRef     = `${serviceUrl}|||${conversationId}`

  await processIncomingMessage(fastify, {
    workspaceId:      channel.workspace_id.toString(),
    channelId:        channel._id.toString(),
    channelRef,
    channelType:      'teams',
    name,
    text:             cleanText,
    channelMessageId: activity.id,
    metadata:         {
      teams_user_id:       userId,
      teams_service_url:   serviceUrl,
      teams_conversation_id: conversationId,
      teams_channel_id:    activity.channelData?.teamsChannelId || null,
    },
  })
}

/** Extrae la parte local de una dirección de email (antes del @) */
function extractLocalPart(address) {
  const match = address.match(/^([^@]+)/)
  return match ? match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : address
}

/**
 * ─── Email: función central de procesamiento ─────────────────────────────────
 *
 * Igual que processIncomingMessage pero para el canal email.
 * Hilo de conversación: busca conversaciones abiertas con el mismo contact
 * Y cuyo metadata.email_thread_id coincida con el In-Reply-To o Message-ID.
 *
 * @param {object} fastify
 * @param {object} parsed     - Resultado de parseSendGrid/parseMailgun/parsePostmark
 * @param {object} channel    - Documento Channel de tipo 'email'
 */
async function processIncomingEmail(fastify, parsed, channel) {
  const workspaceId = channel.workspace_id.toString()

  // Paso 1: Identificar contacto por email
  const contact = await contactService.findOrCreateContact(workspaceId, {
    channelRef:  parsed.from,
    channelType: 'email',
    name:        parsed.fromName || parsed.from,
    email:       parsed.from,
  })

  // Paso 2: Buscar conversación existente por hilo (In-Reply-To / References)
  let isNew = false
  let conversation = null

  const threadIds = [parsed.inReplyTo, ...(parsed.references || [])].filter(Boolean)

  if (threadIds.length) {
    // Buscar conversación activa cuyo thread_message_id esté en la cadena
    conversation = await Conversation.findOne({
      workspace_id: workspaceId,
      contact_id:   contact._id,
      status:       { $nin: ['resolved', 'abandoned'] },
      'metadata.email_thread_ids': { $in: threadIds },
    })
  }

  // Si no hay hilo, buscar conversación abierta reciente del mismo contacto y canal
  if (!conversation) {
    conversation = await Conversation.findOne({
      workspace_id: workspaceId,
      contact_id:   contact._id,
      channel_id:   channel._id,
      status:       { $nin: ['resolved', 'abandoned'] },
    }).sort({ createdAt: -1 })
  }

  if (!conversation) {
    await fastify.checkLimit(workspaceId, 'conversation')
    conversation = await convService.createConversation(workspaceId, {
      contactId: contact._id,
      channelId: channel._id.toString(),
      metadata: {
        email_subject:    parsed.subject,
        email_thread_ids: [parsed.messageId].filter(Boolean),
      },
    })
    await fastify.incrementConversation(workspaceId)
    isNew = true
  } else {
    // Agregar el nuevo messageId al array de thread_ids para futuros replies
    if (parsed.messageId) {
      await Conversation.findByIdAndUpdate(conversation._id, {
        $addToSet: { 'metadata.email_thread_ids': parsed.messageId },
      })
    }
  }

  // Paso 3: Guardar mensaje
  const { isDuplicate } = await msgService.createMessage({
    workspaceId,
    conversationId: conversation._id,
    senderType:     'contact',
    type:           'text',
    content:        parsed.text || '(sin contenido)',
    channelMessageId: parsed.messageId,
    // Guardamos metadata del email para poder responder en el mismo hilo
    metadata: {
      email_message_id:  parsed.messageId  || null,
      email_in_reply_to: parsed.inReplyTo  || null,
      subject:           parsed.subject    || '',
    },
    aiMeta: {
      email_subject:  parsed.subject,
      email_from:     parsed.from,
      in_reply_to:    parsed.inReplyTo,
      references:     parsed.references,
    },
  })

  if (isDuplicate) return

  fastify.io?.to(`workspace:${workspaceId}`).emit('new:message', {
    conversationId: conversation._id,
    workspaceId,
  })

  // Paso 4: Enrutamiento (igual que otros canales)
  const workspace = await Workspace.findById(workspaceId).lean()
  if (!workspace?.active) return
  if (conversation.status === 'assigned') return

  const io = fastify.io

  if (isNew) {
    const botStart = await botService.startBotFlow({ workspaceId, conversation, io })
    if (!botStart.handled) {
      await convService.escalateToQueue(workspaceId, conversation._id)
      io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
    } else if (botStart.shouldEscalate) {
      await convService.escalateToQueue(workspaceId, conversation._id, {
        assignedMemberId:     botStart.assignedMemberId,
        assignedDepartmentId: botStart.assignedDepartmentId,
      })
      io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
    }
    return
  }

  if (conversation.status === 'bot') {
    const { shouldEscalate, resolved, assignedMemberId, assignedDepartmentId } = await botService.handleMessage({
      workspaceId,
      conversation,
      userMessage: parsed.text || '',
      io,
    })
    if (resolved) {
      io?.to(`workspace:${workspaceId}`).emit('conversation:resolved', { id: conversation._id })
      return
    }
    if (shouldEscalate) {
      await convService.escalateToQueue(workspaceId, conversation._id, { assignedMemberId, assignedDepartmentId })
      io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
    }
    return
  }

  const { handler } = await routingService.decideHandler(workspace, conversation)
  if (handler !== 'bot') {
    await convService.escalateToQueue(workspaceId, conversation._id)
    io?.to(`workspace:${workspaceId}`).emit('conversation:pending', { id: conversation._id })
  }
}

module.exports = webhookRoutes
