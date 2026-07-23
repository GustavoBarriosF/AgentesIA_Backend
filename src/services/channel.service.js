'use strict'

const axios = require('axios')
const Channel = require('../db/models/channel')
const logger = require('../utils/logger')

async function listChannels(workspaceId) {
  return Channel.find({ workspace_id: workspaceId }).lean()
}

async function createChannel(workspaceId, { name, type, config }) {
  return Channel.create({ workspace_id: workspaceId, name, type, config: config || {} })
}

async function getChannel(workspaceId, channelId) {
  const channel = await Channel.findOne({ _id: channelId, workspace_id: workspaceId }).lean()
  if (!channel) throw Object.assign(new Error('Canal no encontrado'), { statusCode: 404 })
  return channel
}

async function updateChannel(workspaceId, channelId, data) {
  const channel = await Channel.findOneAndUpdate(
    { _id: channelId, workspace_id: workspaceId },
    { $set: data },
    { new: true, runValidators: true }
  )
  if (!channel) throw Object.assign(new Error('Canal no encontrado'), { statusCode: 404 })
  return channel
}

async function toggleChannel(workspaceId, channelId, active) {
  return updateChannel(workspaceId, channelId, { active })
}

function getWidgetScript(workspace) {
  const apiUrl = process.env.PUBLIC_API_URL || 'http://localhost:3000'
  return `<!-- NexoraChat Widget -->
<script>
  (function(w,d,s,o,f,js,fjs){
    w['NexoraChat']=o;w[o]=w[o]||function(){(w[o].q=w[o].q||[]).push(arguments)};
    js=d.createElement(s),fjs=d.getElementsByTagName(s)[0];
    js.id=o;js.src=f;js.async=1;fjs.parentNode.insertBefore(js,fjs);
  }(window,document,'script','tc','${apiUrl}/widget.js'));
  tc('init', { workspace: '${workspace.slug}' });
</script>`
}

/**
 * Envia un mensaje al canal externo correspondiente
 */
async function sendToChannel(channel, recipientRef, message, conversationId) {
  switch (channel.type) {
    case 'whatsapp':
      return sendWhatsApp(channel.config, recipientRef, message)
    case 'whatsapp_baileys':
      return sendWhatsAppBaileys(channel._id.toString(), recipientRef, message)
    case 'telegram':
      return sendTelegram(channel.config, recipientRef, message)
    case 'facebook_messenger':
      return sendMetaMessenger(channel.config, recipientRef, message)
    case 'instagram_dm': {
      const { sendInstagramMessage } = require('./meta.service')
      return sendInstagramMessage(channel.config, recipientRef, message)
    }
    case 'email': {
      // Obtener headers de threading del primer mensaje del contacto en esta conversación
      const Message = require('../db/models/message')
      const firstContactMsg = conversationId
        ? await Message.findOne({
            conversation_id: conversationId,
            sender_type: 'contact',
          }).sort({ createdAt: 1 }).lean()
        : null

      const subject = firstContactMsg?.email_subject
        ? (firstContactMsg.email_subject.startsWith('Re:')
            ? firstContactMsg.email_subject
            : `Re: ${firstContactMsg.email_subject}`)
        : 'Re: Tu consulta'

      if (!channel.config?.smtp_host && !channel.config?.sendgrid_api_key && !channel.config?.mailgun_api_key) {
        throw new Error('Canal email sin configuración SMTP o proveedor de envío')
      }

      const emailService = require('./email.service')
      return emailService.sendEmailReply(channel.config, {
        to:         recipientRef,
        subject,
        text:       typeof message === 'string' ? message : message.content,
        inReplyTo:  firstContactMsg?.email_message_id || null,
        references: firstContactMsg?.email_message_id ? [firstContactMsg.email_message_id] : [],
      })
    }
    case 'sms':
      return sendSMS(channel.config, recipientRef, message)
    case 'line':
      return sendLine(channel.config, recipientRef, message)
    case 'slack':
      return sendSlack(channel.config, recipientRef, message)
    case 'teams':
      return sendTeams(channel.config, recipientRef, message)
    case 'web_widget':
    case 'api':
      // Se entrega via WebSocket, no hay llamada externa
      return
    default:
      logger.warn({ channelType: channel.type }, 'Tipo de canal no soportado para envio')
  }
}

async function sendWhatsAppBaileys(channelId, to, message) {
  const baileysService = require('./baileys.service')
  return baileysService.sendMessage(channelId, to, message)
}

/**
 * Estima el número de segmentos y el costo aproximado de un SMS.
 * Asume charset GSM-7 (1 seg = 160 chars, multi-seg = 153 chars/seg).
 * El costo es una aproximación basada en tarifa US de Twilio (~$0.0075/seg).
 */
function estimateSmsCost(text) {
  const len = (text || '').length
  const segments = len <= 160 ? 1 : Math.ceil(len / 153)
  return { segments, cost: parseFloat((segments * 0.0075).toFixed(4)) }
}

/**
 * Envía un SMS a través del proveedor configurado en el canal.
 * config: { provider: 'twilio'|'vonage'|'sns', phone_number, ... credenciales del proveedor }
 * recipientRef: número de teléfono destino en formato E.164 (+57300...)
 *
 * Soporta MMS cuando message.type === 'image' y message.metadata.media_url está presente.
 */
async function sendSMS(config, recipientRef, message) {
  const provider = config.provider || 'twilio'

  if (provider === 'twilio') {
    return sendSmsTwilio(config, recipientRef, message)
  }
  if (provider === 'vonage') {
    return sendSmsVonage(config, recipientRef, message)
  }
  if (provider === 'sns') {
    return sendSmsSNS(config, recipientRef, message)
  }
  throw new Error(`Proveedor SMS no soportado: ${provider}`)
}

async function sendSmsTwilio(config, to, message) {
  const { account_sid, auth_token, phone_number } = config
  if (!account_sid || !auth_token || !phone_number) {
    throw new Error('Canal SMS Twilio sin credenciales completas')
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${account_sid}/Messages.json`
  const params = new URLSearchParams({
    From: phone_number,
    To:   to,
    Body: message.content || '',
  })

  // MMS: incluir MediaUrl si hay imagen adjunta
  if (message.type === 'image' && message.metadata?.media_url) {
    params.set('MediaUrl', message.metadata.media_url)
  }

  try {
    const res = await axios.post(url, params, {
      auth: { username: account_sid, password: auth_token },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    const { segments, cost } = estimateSmsCost(message.content)
    return { sid: res.data.sid, segments, cost, provider: 'twilio' }
  } catch (err) {
    logger.error({ err: err.response?.data || err.message }, '[SMS/Twilio] Error enviando')
    throw err
  }
}

async function sendSmsVonage(config, to, message) {
  const { api_key, api_secret, phone_number } = config
  if (!api_key || !api_secret || !phone_number) {
    throw new Error('Canal SMS Vonage sin credenciales completas')
  }

  try {
    const res = await axios.post('https://rest.nexmo.com/sms/json', {
      api_key,
      api_secret,
      from: phone_number,
      to,
      text: message.content || '',
    })
    const msgs = res.data?.messages || []
    if (msgs[0]?.status !== '0') {
      throw new Error(`Vonage error: ${msgs[0]?.['error-text'] || 'Unknown error'}`)
    }
    const { segments, cost } = estimateSmsCost(message.content)
    return { message_id: msgs[0]['message-id'], segments, cost, provider: 'vonage' }
  } catch (err) {
    logger.error({ err: err.response?.data || err.message }, '[SMS/Vonage] Error enviando')
    throw err
  }
}

async function sendSmsSNS(config, to, message) {
  const { aws_access_key_id, aws_secret_access_key, aws_region } = config
  if (!aws_access_key_id || !aws_secret_access_key) {
    throw new Error('Canal SMS SNS sin credenciales AWS configuradas')
  }

  // Firma AWS Signature v4 para SNS Publish
  // Para simplicidad usamos el SDK si está disponible; si no, axios con firma manual.
  // Se asume que @aws-sdk/client-sns está instalado o se usa la API HTTP directa.
  try {
    const region = aws_region || 'us-east-1'
    const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns')
    const client = new SNSClient({
      region,
      credentials: { accessKeyId: aws_access_key_id, secretAccessKey: aws_secret_access_key },
    })
    const cmd = new PublishCommand({
      PhoneNumber: to,
      Message:     message.content || '',
      MessageAttributes: {
        'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
      },
    })
    const res = await client.send(cmd)
    const { segments, cost } = estimateSmsCost(message.content)
    return { message_id: res.MessageId, segments, cost, provider: 'sns' }
  } catch (err) {
    logger.error({ err: err.message }, '[SMS/SNS] Error enviando')
    throw err
  }
}

/**
 * Envía un mensaje a un usuario de LINE via push message API.
 * config: { channel_access_token, channel_secret }
 * recipientRef: LINE userId (ej: "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")
 */
async function sendLine(config, userId, message) {
  const { channel_access_token } = config
  if (!channel_access_token) throw new Error('Canal LINE sin channel_access_token')

  const lineMessage = { type: 'text', text: message.content || '' }

  // Flex message si está definido en metadata
  const flexPayload = message.metadata?.line_flex
  const messages = flexPayload
    ? [{ type: 'flex', altText: message.content || 'Mensaje', contents: flexPayload }]
    : [lineMessage]

  try {
    const res = await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: userId, messages },
      { headers: { Authorization: `Bearer ${channel_access_token}`, 'Content-Type': 'application/json' } }
    )
    return res.data
  } catch (err) {
    logger.error({ err: err.response?.data || err.message }, '[LINE] Error enviando mensaje')
    throw err
  }
}

/**
 * Envía un mensaje a un usuario de Slack via chat.postMessage.
 * config: { bot_token, team_id, team_name }
 * recipientRef: Slack channel/DM ID (ej: "D01234ABC" para DM, "C01234ABC" para canal)
 */
async function sendSlack(config, recipientRef, message) {
  const { bot_token } = config
  if (!bot_token) throw new Error('Canal Slack sin bot_token configurado')

  const payload = {
    channel: recipientRef,
    text: message.content,
  }

  // Block Kit: si message.blocks está definido, usarlo en lugar de text
  if (message.metadata?.slack_blocks) {
    payload.blocks = message.metadata.slack_blocks
    payload.text = message.content // fallback para notificaciones
  }

  try {
    const res = await axios.post('https://slack.com/api/chat.postMessage', payload, {
      headers: {
        Authorization: `Bearer ${bot_token}`,
        'Content-Type': 'application/json',
      },
    })
    if (!res.data.ok) throw new Error(`Slack API error: ${res.data.error}`)
    return res.data
  } catch (err) {
    logger.error({ err: err.response?.data || err.message }, 'Error enviando mensaje de Slack')
    throw err
  }
}

/**
 * Envía una respuesta en una conversación de Microsoft Teams via Bot Framework.
 * config: { app_id, app_password }
 * recipientRef: "serviceUrl|||conversationId" (separado por |||)
 */
async function sendTeams(config, recipientRef, message) {
  const { app_id, app_password } = config
  if (!app_id || !app_password) throw new Error('Canal Teams sin credenciales configuradas')

  const [serviceUrl, conversationId] = recipientRef.split('|||')
  if (!serviceUrl || !conversationId) throw new Error('recipientRef de Teams inválido')

  // Obtener token de acceso del Bot Framework
  const tokenRes = await axios.post(
    'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: app_id,
      client_secret: app_password,
      scope: 'https://api.botframework.com/.default',
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  )
  const accessToken = tokenRes.data.access_token

  const activity = {
    type: 'message',
    text: message.content,
  }

  // Adaptive Card si está definida
  if (message.metadata?.teams_card) {
    activity.attachments = [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: message.metadata.teams_card,
    }]
  }

  try {
    const url = `${serviceUrl.replace(/\/$/, '')}/v3/conversations/${conversationId}/activities`
    const res = await axios.post(url, activity, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    })
    return res.data
  } catch (err) {
    logger.error({ err: err.response?.data || err.message }, 'Error enviando mensaje de Teams')
    throw err
  }
}

/**
 * Envia un mensaje de WhatsApp usando las credenciales del canal del cliente.
 * config debe contener:
 *   - phone_number_id: ID del numero en Meta Business
 *   - access_token:    Token de acceso permanente de la Meta App del cliente
 *   - app_secret:      App Secret para verificacion HMAC de webhooks entrantes
 *   - verify_token:    Token que el cliente configura al registrar el webhook en Meta
 */
async function sendWhatsApp(config, to, message) {
  const { phone_number_id, access_token } = config
  const url = `https://graph.facebook.com/${process.env.META_GRAPH_API_VERSION || 'v18.0'}/${phone_number_id}/messages`

  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: message.content },
  }

  try {
    const res = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    })
    return res.data
  } catch (err) {
    logger.error({ err: err.response?.data }, 'Error enviando mensaje de WhatsApp')
    throw err
  }
}

async function sendTelegram(config, chatId, message) {
  const { bot_token } = config
  const url = `https://api.telegram.org/bot${bot_token}/sendMessage`

  try {
    const res = await axios.post(url, { chat_id: chatId, text: message.content })
    return res.data
  } catch (err) {
    logger.error({ err: err.response?.data }, 'Error enviando mensaje de Telegram')
    throw err
  }
}

/**
 * Envía un mensaje via Meta Messenger Platform (Facebook Messenger o Instagram DM).
 * El endpoint es el mismo para ambos — la diferencia está en el recipientId:
 *   Messenger → PSID del usuario
 *   Instagram → IGSID del usuario
 */
async function sendMetaMessenger(config, recipientId, message) {
  const { sendMetaMessage } = require('./meta.service')
  return sendMetaMessage(config, recipientId, message)
}

module.exports = { listChannels, createChannel, getChannel, updateChannel, toggleChannel, getWidgetScript, sendToChannel }
