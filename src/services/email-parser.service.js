'use strict'

/**
 * email-parser.service.js — Parsea los payloads de emails entrantes.
 *
 * Soporta los formatos de tres proveedores de inbound parsing:
 *   - SendGrid Inbound Parse  (multipart/form-data)
 *   - Mailgun Routes          (multipart/form-data)
 *   - Postmark Inbound        (application/json)
 *
 * Retorna siempre un objeto normalizado:
 * {
 *   messageId:   string    — Message-ID del email (para deduplicación y threading)
 *   inReplyTo:   string|null — In-Reply-To header (para threading)
 *   references:  string[]  — References header separado en array
 *   from:        string    — Dirección de origen
 *   fromName:    string    — Nombre del remitente
 *   to:          string    — Dirección destino (la del workspace)
 *   subject:     string
 *   text:        string    — Cuerpo en texto plano
 *   html:        string|null — Cuerpo HTML si viene
 *   attachments: { filename, contentType, content }[]
 * }
 */

const { htmlToText } = require('./email.service')
const { processIncomingMessage } = require('./incoming-message.service')
const logger = require('../utils/logger')

/**
 * Parsea el payload de SendGrid Inbound Parse.
 * SendGrid envía un form-data con campos: from, to, subject, text, html,
 * headers (raw headers como string), envelope (JSON string), attachments
 */
function parseSendGrid(body) {
  const rawHeaders  = body.headers || ''
  const messageId   = extractHeader(rawHeaders, 'Message-ID') || `<sg-${Date.now()}@inbound>`
  const inReplyTo   = extractHeader(rawHeaders, 'In-Reply-To') || null
  const references  = extractHeader(rawHeaders, 'References')?.split(/\s+/).filter(Boolean) || []

  const { fromEmail, fromName } = parseFromField(body.from || '')

  return {
    messageId,
    inReplyTo,
    references,
    from:        fromEmail,
    fromName,
    to:          extractEmail(body.to || ''),
    subject:     body.subject || '(sin asunto)',
    text:        body.text || (body.html ? htmlToText(body.html) : ''),
    html:        body.html || null,
    attachments: parseAttachments(body, 'sendgrid'),
  }
}

/**
 * Parsea el payload de Mailgun Routes (Inbound).
 * Mailgun también envía form-data con campos similares a SendGrid.
 * Campos: from, To, subject, body-plain, body-html, Message-Id,
 *         In-Reply-To, References, attachments (numeradas)
 */
function parseMailgun(body) {
  const messageId  = body['Message-Id'] || body['message-id'] || `<mg-${Date.now()}@inbound>`
  const inReplyTo  = body['In-Reply-To'] || body['in-reply-to'] || null
  const references = (body['References'] || body['references'] || '')
    .split(/\s+/).filter(Boolean)

  const { fromEmail, fromName } = parseFromField(body.from || body.From || '')

  return {
    messageId,
    inReplyTo,
    references,
    from:        fromEmail,
    fromName,
    to:          extractEmail(body.To || body.to || ''),
    subject:     body.subject || body.Subject || '(sin asunto)',
    text:        body['body-plain'] || (body['body-html'] ? htmlToText(body['body-html']) : ''),
    html:        body['body-html'] || null,
    attachments: parseAttachments(body, 'mailgun'),
  }
}

/**
 * Parsea el payload de Postmark Inbound (JSON).
 * Postmark envía JSON con campos: From, To, Subject, TextBody, HtmlBody,
 * MessageID, InReplyTo, Headers[], Attachments[]
 */
function parsePostmark(body) {
  const inReplyTo = body.InReplyTo || null
  const refHeader = (body.Headers || []).find(h => h.Name === 'References')
  const references = refHeader?.Value?.split(/\s+/).filter(Boolean) || []

  const { fromEmail, fromName } = parseFromField(body.From || body.FromFull?.Email || '')

  const attachments = (body.Attachments || []).map(a => ({
    filename:    a.Name,
    contentType: a.ContentType,
    content:     Buffer.from(a.Content, 'base64'),
  }))

  return {
    messageId:   body.MessageID ? `<${body.MessageID}>` : `<pm-${Date.now()}@inbound>`,
    inReplyTo,
    references,
    from:        fromEmail || body.FromFull?.Email || '',
    fromName:    fromName  || body.FromFull?.Name  || '',
    to:          extractEmail(body.To || body.ToFull?.[0]?.Email || ''),
    subject:     body.Subject || '(sin asunto)',
    text:        body.TextBody || (body.HtmlBody ? htmlToText(body.HtmlBody) : ''),
    html:        body.HtmlBody || null,
    attachments,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extrae un header específico de los raw headers de SendGrid.
 * @param {string} rawHeaders - Bloque de headers como string
 * @param {string} name       - Nombre del header (case-insensitive)
 */
function extractHeader(rawHeaders, name) {
  const regex = new RegExp(`^${name}:\\s*(.+)$`, 'im')
  const match = rawHeaders.match(regex)
  return match ? match[1].trim() : null
}

/**
 * Parsea un campo From: "Nombre" <email@ejemplo.com>
 * o simplemente email@ejemplo.com
 */
function parseFromField(from) {
  const full = /^"?([^"<]*)"?\s*<([^>]+)>/.exec(from)
  if (full) {
    return { fromName: full[1].trim(), fromEmail: full[2].trim().toLowerCase() }
  }
  const email = extractEmail(from)
  return { fromName: email.split('@')[0], fromEmail: email }
}

/**
 * Extrae la primera dirección de email de un string.
 */
function extractEmail(str) {
  const match = str.match(/[\w.+-]+@[\w-]+\.[\w.]+/)
  return match ? match[0].toLowerCase() : str.toLowerCase().trim()
}

/**
 * Parsea adjuntos según el proveedor.
 * Por simplicidad guardamos solo metadata (no subimos a storage aquí).
 */
function parseAttachments(body, provider) {
  const attachments = []

  if (provider === 'sendgrid') {
    const count = parseInt(body['attachments'] || '0')
    for (let i = 1; i <= count; i++) {
      attachments.push({
        filename:    body[`attachment-info`] ? JSON.parse(body['attachment-info'])[`attachment${i}`]?.filename : `archivo-${i}`,
        contentType: 'application/octet-stream',
        content:     null,
      })
    }
  } else if (provider === 'mailgun') {
    const count = parseInt(body['attachment-count'] || '0')
    for (let i = 1; i <= count; i++) {
      attachments.push({
        filename:    `archivo-${i}`,
        contentType: 'application/octet-stream',
        content:     null,
      })
    }
  }

  return attachments
}

// ─── Integración con el flujo de conversaciones ───────────────────────────────

/**
 * Parsea un campo "From" en formato libre y retorna email y nombre.
 * Soporta: "Nombre <email@domain.com>", "<email@domain.com>", "email@domain.com"
 */
function parseFromAddress(from) {
  if (!from) return { email: '', name: '' }
  // Formato: "Nombre" <email@domain.com> o solo email@domain.com
  const angleMatch = from.match(/<([^>]+)>/)
  if (angleMatch) {
    const email = angleMatch[1].trim().toLowerCase()
    const name  = from.replace(/<[^>]+>/, '').replace(/['"]/g, '').trim()
    return { email, name: name || email }
  }
  // Solo dirección de email
  const email = from.trim().toLowerCase()
  return { email, name: email }
}

/**
 * Conecta un email entrante al flujo central de conversaciones.
 *
 * @param {object} fastify        - Instancia de Fastify
 * @param {object} channel        - Documento Channel de tipo 'email'
 * @param {object} rawEmailData   - Payload crudo del proveedor de email
 */
async function processInboundEmail(fastify, channel, rawEmailData) {
  const raw = rawEmailData || {}

  // Extraer campos del payload crudo (compatibilidad con distintos proveedores)
  const fromRaw    = raw.from || raw.From || ''
  const subject    = raw.subject || raw.Subject || '(sin asunto)'
  const text       = raw.text || raw.plain || raw['body-plain'] || raw.TextBody || ''

  // Message-ID e In-Reply-To: pueden venir como campos directos o dentro de headers
  const headers      = raw.headers || {}
  const messageId    = raw['message-id'] || raw['Message-Id'] || raw.MessageID
    || (typeof headers === 'object' ? headers['message-id'] || headers['Message-ID'] : null)
    || extractHeader(typeof headers === 'string' ? headers : '', 'Message-ID')
    || `<gen-${Date.now()}@inbound>`
  const inReplyTo    = raw['in-reply-to'] || raw['In-Reply-To'] || raw.InReplyTo
    || (typeof headers === 'object' ? headers['in-reply-to'] || headers['In-Reply-To'] : null)
    || extractHeader(typeof headers === 'string' ? headers : '', 'In-Reply-To')
    || null

  // Normalizar email del remitente
  const { email: fromEmail, name: fromName } = parseFromAddress(fromRaw)
  const senderEmail = fromEmail || fromRaw.trim().toLowerCase()
  const senderName  = fromName  || senderEmail

  // Truncar texto a 10 000 chars para evitar payloads excesivos
  const truncatedText = text.length > 10000 ? text.slice(0, 10000) : text

  await processIncomingMessage(fastify, {
    workspaceId:      channel.workspace_id.toString(),
    channelId:        channel._id.toString(),
    channelRef:       senderEmail,
    channelType:      'email',
    name:             senderName,
    text:             truncatedText,
    channelMessageId: messageId,
    metadata: {
      subject,
      email_message_id: messageId,
      email_in_reply_to: inReplyTo,
    },
  })
}

module.exports = { parseSendGrid, parseMailgun, parsePostmark, processInboundEmail }
