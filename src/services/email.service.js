'use strict'

/**
 * email.service.js — Envío de emails de respuesta para el canal Email.
 *
 * Soporta tres proveedores de envío:
 *   - SMTP (nodemailer)   → cualquier servidor SMTP (Gmail, Outlook, propio)
 *   - SendGrid API        → si el workspace configuró SendGrid como salida
 *   - Mailgun API         → si el workspace configuró Mailgun como salida
 *
 * El canal de tipo 'email' guarda en config:
 *   {
 *     inbound_provider:  'sendgrid' | 'mailgun' | 'postmark'
 *     inbound_address:   'soporte@midominio.com'   (el from que esperan los clientes)
 *     outbound_provider: 'smtp' | 'sendgrid' | 'mailgun'
 *     smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass  (si outbound = smtp)
 *     sendgrid_api_key   (si outbound = sendgrid)
 *     mailgun_api_key, mailgun_domain, mailgun_region  (si outbound = mailgun)
 *     signature_html:    '<p>-- Firma del workspace</p>'
 *   }
 */

const axios  = require('axios')
const logger = require('../utils/logger')

/**
 * Envía un email de respuesta.
 *
 * @param {object} channelConfig  - config del canal de tipo 'email'
 * @param {object} opts
 * @param {string}   opts.to          - Dirección destino
 * @param {string}   opts.toName      - Nombre del destinatario
 * @param {string}   opts.subject     - Asunto (ya calculado con RE: si aplica)
 * @param {string}   opts.text        - Cuerpo en texto plano
 * @param {string}   [opts.html]      - Cuerpo en HTML (opcional)
 * @param {string}   [opts.inReplyTo] - Message-ID del email original (hilo)
 * @param {string[]} [opts.references]- Lista de Message-IDs del hilo
 * @param {string}   [opts.messageId] - Message-ID a asignar al email saliente
 */
async function sendEmailReply(channelConfig, { to, toName, subject, text, html, inReplyTo, references, messageId }) {
  const provider = channelConfig.outbound_provider || 'smtp'
  const from     = channelConfig.reply_to || channelConfig.inbox_address || channelConfig.smtp_user
  const fromName = channelConfig.display_name   || from

  // Agregar firma al texto plano si está configurada
  const signature = channelConfig.signature_html
    ? htmlToText(channelConfig.signature_html)
    : ''
  const bodyText  = signature ? `${text}\n\n--\n${signature}` : text
  const bodyHtml  = html
    ? `${html}${channelConfig.signature_html ? `<br><br>--<br>${channelConfig.signature_html}` : ''}`
    : `<p>${bodyText.replace(/\n/g, '<br>')}</p>`

  switch (provider) {
    case 'smtp':
      return sendSmtp(channelConfig, { from, fromName, to, toName, subject, text: bodyText, html: bodyHtml, inReplyTo, references, messageId })
    case 'sendgrid':
      return sendViaSendGrid(channelConfig.sendgrid_api_key, { from, fromName, to, toName, subject, text: bodyText, html: bodyHtml, inReplyTo, references, messageId })
    case 'mailgun':
      return sendViaMailgun(channelConfig, { from, to, subject, text: bodyText, html: bodyHtml, inReplyTo, references, messageId })
    default:
      throw Object.assign(new Error(`Proveedor de salida '${provider}' no soportado`), { statusCode: 501 })
  }
}

// ─── SMTP ─────────────────────────────────────────────────────────────────────

async function sendSmtp(config, { from, fromName, to, toName, subject, text, html, inReplyTo, references, messageId }) {
  const nodemailer = require('nodemailer')

  const transporter = nodemailer.createTransport({
    host:   config.smtp_host,
    port:   parseInt(config.smtp_port || '587'),
    secure: config.smtp_secure === true || config.smtp_port === '465',
    auth: {
      user: config.smtp_user,
      pass: config.smtp_password,
    },
    connectionTimeout: 15_000,
    greetingTimeout:   10_000,
  })

  const mailOptions = {
    from:       `"${fromName}" <${from}>`,
    to:         toName ? `"${toName}" <${to}>` : to,
    subject,
    text,
    html,
  }

  if (messageId)  mailOptions['Message-ID'] = messageId
  if (inReplyTo)  mailOptions['In-Reply-To'] = inReplyTo
  if (references?.length) mailOptions['References'] = references.join(' ')

  try {
    const info = await transporter.sendMail(mailOptions)
    logger.info({ messageId: info.messageId }, '[Email SMTP] Mensaje enviado')
    return { messageId: info.messageId }
  } catch (err) {
    logger.error({ err: err.message }, '[Email SMTP] Error enviando')
    throw Object.assign(new Error(`SMTP: ${err.message}`), { statusCode: 502 })
  }
}

// ─── SendGrid ────────────────────────────────────────────────────────────────

async function sendViaSendGrid(apiKey, { from, fromName, to, toName, subject, text, html, inReplyTo, references, messageId }) {
  if (!apiKey) throw Object.assign(new Error('SendGrid API key no configurada'), { statusCode: 400 })

  const headers = {}
  if (messageId)  headers['Message-ID'] = messageId
  if (inReplyTo)  headers['In-Reply-To'] = inReplyTo
  if (references?.length) headers['References'] = references.join(' ')

  const body = {
    personalizations: [{ to: [{ email: to, name: toName || to }] }],
    from:             { email: from, name: fromName },
    subject,
    content: [
      { type: 'text/plain', value: text },
      { type: 'text/html',  value: html },
    ],
    headers: Object.keys(headers).length ? headers : undefined,
  }

  try {
    await axios.post('https://api.sendgrid.com/v3/mail/send', body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 20_000,
    })
    logger.info({ to, subject }, '[Email SendGrid] Mensaje enviado')
    return { messageId: messageId || `<sg-${Date.now()}@sendgrid>` }
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message
    logger.error({ err: msg }, '[Email SendGrid] Error enviando')
    throw Object.assign(new Error(`SendGrid: ${msg}`), { statusCode: err.response?.status || 502 })
  }
}

// ─── Mailgun ─────────────────────────────────────────────────────────────────

async function sendViaMailgun(config, { from, to, subject, text, html, inReplyTo, references, messageId }) {
  const { mailgun_api_key, mailgun_domain, mailgun_region } = config
  if (!mailgun_api_key || !mailgun_domain) {
    throw Object.assign(new Error('Mailgun api_key y domain son requeridos'), { statusCode: 400 })
  }

  const base   = mailgun_region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net'
  const url    = `${base}/v3/${mailgun_domain}/messages`
  const params = new URLSearchParams({ from, to, subject, text, html })

  if (messageId)  params.append('h:Message-ID', messageId)
  if (inReplyTo)  params.append('h:In-Reply-To', inReplyTo)
  if (references?.length) params.append('h:References', references.join(' '))

  try {
    const res = await axios.post(url, params.toString(), {
      auth: { username: 'api', password: mailgun_api_key },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20_000,
    })
    logger.info({ id: res.data.id }, '[Email Mailgun] Mensaje enviado')
    return { messageId: res.data.id }
  } catch (err) {
    const msg = err.response?.data?.message || err.message
    logger.error({ err: msg }, '[Email Mailgun] Error enviando')
    throw Object.assign(new Error(`Mailgun: ${msg}`), { statusCode: err.response?.status || 502 })
  }
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

/**
 * Convierte HTML simple a texto plano eliminando tags.
 */
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Construye el asunto de respuesta (agrega RE: si no lo tiene).
 */
function buildReplySubject(subject) {
  if (!subject) return 'Re: (sin asunto)'
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`
}

/**
 * Verifica las credenciales SMTP haciendo un VERIFY.
 */
async function verifySmtpCredentials(config) {
  const nodemailer = require('nodemailer')
  const transporter = nodemailer.createTransport({
    host:   config.smtp_host,
    port:   parseInt(config.smtp_port || '587'),
    secure: config.smtp_secure === true || config.smtp_port === '465',
    auth: { user: config.smtp_user, pass: config.smtp_password },
    connectionTimeout: 10_000,
  })
  try {
    await transporter.verify()
    return { valid: true }
  } catch (err) {
    return { valid: false, error: err.message }
  }
}

/**
 * Verifica credenciales de SendGrid enviando un ping a la API.
 */
async function verifySendGridCredentials(apiKey) {
  try {
    await axios.get('https://api.sendgrid.com/v3/user/account', {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 10_000,
    })
    return { valid: true }
  } catch (err) {
    return { valid: false, error: err.response?.data?.errors?.[0]?.message || err.message }
  }
}

/**
 * Verifica credenciales de Mailgun consultando el dominio.
 */
async function verifyMailgunCredentials(apiKey, domain, region) {
  const base = region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net'
  try {
    await axios.get(`${base}/v3/domains/${domain}`, {
      auth: { username: 'api', password: apiKey },
      timeout: 10_000,
    })
    return { valid: true }
  } catch (err) {
    return { valid: false, error: err.response?.data?.message || err.message }
  }
}

module.exports = {
  sendEmailReply,
  buildReplySubject,
  htmlToText,
  verifySmtpCredentials,
  verifySendGridCredentials,
  verifyMailgunCredentials,
}
