'use strict'

/**
 * mailer.service.js — Emails transaccionales del sistema.
 *
 * Proveedores soportados (configurar en .env):
 *   EMAIL_PROVIDER=resend    → RESEND_API_KEY=re_...
 *   EMAIL_PROVIDER=sendgrid  → SENDGRID_API_KEY=SG.xxx
 *
 * Variables de entorno:
 *   FROM_EMAIL    = noreply@tudominio.com
 *   FROM_NAME     = NexoraChat              (opcional)
 *   FRONTEND_URL  = https://app.tudominio.com
 */

const axios  = require('axios')
const logger = require('../utils/logger')

const PROVIDER   = process.env.EMAIL_PROVIDER || 'resend'
const FROM_EMAIL = process.env.FROM_EMAIL     || 'noreply@nexorachat.com'
const FROM_NAME  = process.env.FROM_NAME      || 'NexoraChat'
const APP_URL    = process.env.FRONTEND_URL   || 'http://localhost:3001'

// ─── Envío genérico ───────────────────────────────────────────────────────────

async function sendMail({ to, subject, html, text, fromName }) {
  const sender = fromName || FROM_NAME
  switch (PROVIDER) {
    case 'resend':    return sendViaResend({ to, subject, html, text, fromName: sender })
    case 'sendgrid':  return sendViaSendGrid({ to, subject, html, text, fromName: sender })
    default:
      logger.warn({ provider: PROVIDER }, '[Mailer] Proveedor no soportado, email no enviado')
  }
}

// ─── Resend ───────────────────────────────────────────────────────────────────

async function sendViaResend({ to, subject, html, text, fromName }) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey || apiKey.startsWith('re_...')) {
    logger.warn('[Mailer] RESEND_API_KEY no configurada — email no enviado')
    return
  }
  try {
    await axios.post('https://api.resend.com/emails', {
      from:    `${fromName || FROM_NAME} <${FROM_EMAIL}>`,
      to:      [to],
      subject,
      html,
      text:    text || stripHtml(html),
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15_000,
    })
    logger.info({ to, subject }, '[Mailer Resend] Email enviado')
  } catch (err) {
    const msg = err.response?.data?.message || err.message
    logger.error({ err: msg, to }, '[Mailer Resend] Error enviando')
    throw Object.assign(new Error(`Resend: ${msg}`), { statusCode: 502 })
  }
}

// ─── SendGrid ─────────────────────────────────────────────────────────────────

async function sendViaSendGrid({ to, subject, html, text, fromName }) {
  const apiKey = process.env.SENDGRID_API_KEY
  if (!apiKey) {
    logger.warn('[Mailer] SENDGRID_API_KEY no configurada — email no enviado')
    return
  }
  try {
    await axios.post('https://api.sendgrid.com/v3/mail/send', {
      personalizations: [{ to: [{ email: to }] }],
      from:    { email: FROM_EMAIL, name: fromName || FROM_NAME },
      subject,
      content: [
        { type: 'text/plain', value: text || stripHtml(html) },
        { type: 'text/html',  value: html },
      ],
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15_000,
    })
    logger.info({ to, subject }, '[Mailer SendGrid] Email enviado')
  } catch (err) {
    const msg = err.response?.data?.errors?.[0]?.message || err.message
    logger.error({ err: msg, to }, '[Mailer SendGrid] Error enviando')
    throw Object.assign(new Error(`SendGrid: ${msg}`), { statusCode: 502 })
  }
}

// ─── Templates ────────────────────────────────────────────────────────────────

function sendPasswordReset({ to, name, token }) {
  const resetUrl = `${APP_URL}/reset-password?token=${token}`
  return sendMail({
    to,
    subject: 'Recupera tu contraseña — NexoraChat',
    html: `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <!-- Header -->
        <tr>
          <td style="background:#18181b;padding:28px 32px;">
            <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">NexoraChat</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:36px 32px;">
            <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181b;">Recupera tu contraseña</h1>
            <p style="margin:0 0 24px;font-size:15px;color:#71717a;line-height:1.6;">
              Hola ${name ? name + ',' : ','} recibimos una solicitud para restablecer la contraseña de tu cuenta.
            </p>
            <a href="${resetUrl}"
               style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:8px;">
              Restablecer contraseña
            </a>
            <p style="margin:24px 0 0;font-size:13px;color:#a1a1aa;line-height:1.6;">
              Este enlace expira en <strong>1 hora</strong>. Si no solicitaste este cambio, puedes ignorar este email.
            </p>
            <p style="margin:16px 0 0;font-size:12px;color:#d4d4d8;word-break:break-all;">
              Si el botón no funciona, copia este enlace: ${resetUrl}
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #f4f4f5;">
            <p style="margin:0;font-size:12px;color:#a1a1aa;">© ${new Date().getFullYear()} NexoraChat. Todos los derechos reservados.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  })
}

function sendEmailVerification({ to, name, token }) {
  const verifyUrl = `${process.env.PUBLIC_API_URL || 'http://localhost:4000'}/auth/verify-email/${token}`
  return sendMail({
    to,
    subject: 'Verifica tu email — NexoraChat',
    html: `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <tr>
          <td style="background:#18181b;padding:28px 32px;">
            <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">NexoraChat</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 32px;">
            <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#18181b;">Verifica tu email</h1>
            <p style="margin:0 0 24px;font-size:15px;color:#71717a;line-height:1.6;">
              Hola ${name ? name + ',' : ','} gracias por registrarte. Confirma tu dirección de email para activar tu cuenta.
            </p>
            <a href="${verifyUrl}"
               style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 24px;border-radius:8px;">
              Verificar email
            </a>
            <p style="margin:24px 0 0;font-size:13px;color:#a1a1aa;line-height:1.6;">
              Si no creaste esta cuenta, puedes ignorar este email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #f4f4f5;">
            <p style="margin:0;font-size:12px;color:#a1a1aa;">© ${new Date().getFullYear()} NexoraChat. Todos los derechos reservados.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  })
}

function sendTicketUpdate({ to, name, ticketId, title, noteContent, workspaceName }) {
  const senderName = workspaceName || FROM_NAME
  return sendMail({
    to,
    fromName: senderName,
    subject: `Actualización en tu ticket #${ticketId} — ${title}`,
    html: `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <!-- Header -->
        <tr>
          <td style="background:#18181b;padding:28px 32px;">
            <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">${senderName}</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:36px 32px;">
            <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#18181b;">Hay una actualización en tu solicitud</h1>
            <p style="margin:0 0 28px;font-size:15px;color:#71717a;line-height:1.6;">
              Hola${name ? ' ' + name : ''}, nuestro equipo ha publicado una actualización sobre tu caso.
            </p>

            <!-- Ticket ref -->
            <p style="margin:0 0 12px;font-size:12px;font-weight:600;color:#a1a1aa;text-transform:uppercase;letter-spacing:.5px;">
              Ticket #${ticketId} — ${title}
            </p>

            <!-- Note card -->
            <table width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid #0ea5e9;background:#f0f9ff;border-radius:0 8px 8px 0;">
              <tr>
                <td style="padding:16px 20px;">
                  <p style="margin:0;font-size:14px;color:#0c4a6e;line-height:1.7;white-space:pre-wrap;">${noteContent.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
                </td>
              </tr>
            </table>

            <p style="margin:24px 0 0;font-size:13px;color:#a1a1aa;line-height:1.6;">
              Si tienes alguna duda, responde a este correo o contáctanos por el mismo canal donde iniciaste la conversación.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #f4f4f5;">
            <p style="margin:0;font-size:12px;color:#a1a1aa;">© ${new Date().getFullYear()} ${FROM_NAME}. Todos los derechos reservados.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  })
}

function sendTicketConfirmation({ to, name, ticketId, title, description, priority, workspaceName }) {
  const senderName = workspaceName || FROM_NAME
  const PRIORITY_LABELS = { low: 'Baja', medium: 'Media', high: 'Alta', urgent: 'Urgente' }
  const PRIORITY_COLORS = { low: '#22c55e', medium: '#3b82f6', high: '#f97316', urgent: '#ef4444' }
  const priorityLabel = PRIORITY_LABELS[priority] || 'Media'
  const priorityColor = PRIORITY_COLORS[priority] || '#3b82f6'

  const descriptionHtml = description
    ? description.replace(/\n/g, '<br>').replace(/\*(.*?)\*/g, '<strong>$1</strong>')
    : ''

  return sendMail({
    to,
    fromName: senderName,
    subject: `Ticket #${ticketId} registrado — ${title}`,
    html: `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <!-- Header -->
        <tr>
          <td style="background:#18181b;padding:28px 32px;">
            <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">${senderName}</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:36px 32px;">
            <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#18181b;">Tu solicitud fue registrada</h1>
            <p style="margin:0 0 28px;font-size:15px;color:#71717a;line-height:1.6;">
              Hola${name ? ' ' + name : ''}, hemos recibido tu solicitud y nuestro equipo la revisará a la brevedad.
            </p>

            <!-- Ticket card -->
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e4e4e7;border-radius:10px;overflow:hidden;">
              <tr>
                <td style="background:#fafafa;padding:16px 20px;border-bottom:1px solid #e4e4e7;">
                  <p style="margin:0;font-size:11px;font-weight:600;color:#a1a1aa;text-transform:uppercase;letter-spacing:.5px;">Ticket</p>
                  <p style="margin:4px 0 0;font-size:16px;font-weight:700;color:#18181b;">${title}</p>
                </td>
              </tr>
              <tr>
                <td style="padding:16px 20px;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="width:50%;padding-bottom:14px;vertical-align:top;">
                        <p style="margin:0;font-size:11px;font-weight:600;color:#a1a1aa;text-transform:uppercase;letter-spacing:.5px;">ID</p>
                        <p style="margin:4px 0 0;font-size:13px;color:#18181b;font-family:monospace;">#${ticketId}</p>
                      </td>
                      <td style="width:50%;padding-bottom:14px;vertical-align:top;">
                        <p style="margin:0;font-size:11px;font-weight:600;color:#a1a1aa;text-transform:uppercase;letter-spacing:.5px;">Prioridad</p>
                        <p style="margin:4px 0 0;">
                          <span style="display:inline-block;background:${priorityColor}1a;color:${priorityColor};font-size:12px;font-weight:600;padding:2px 10px;border-radius:99px;">${priorityLabel}</span>
                        </p>
                      </td>
                    </tr>
                    ${descriptionHtml ? `
                    <tr>
                      <td colspan="2" style="padding-top:4px;border-top:1px solid #f4f4f5;">
                        <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#a1a1aa;text-transform:uppercase;letter-spacing:.5px;padding-top:14px;">Descripción</p>
                        <p style="margin:0;font-size:14px;color:#3f3f46;line-height:1.7;">${descriptionHtml}</p>
                      </td>
                    </tr>` : ''}
                  </table>
                </td>
              </tr>
            </table>

            <p style="margin:24px 0 0;font-size:13px;color:#a1a1aa;line-height:1.6;">
              Te contactaremos por este mismo canal cuando tengamos una respuesta. No es necesario que respondas este correo.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #f4f4f5;">
            <p style="margin:0;font-size:12px;color:#a1a1aa;">© ${new Date().getFullYear()} ${FROM_NAME}. Todos los derechos reservados.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  })
}

function sendTicketStatusChange({ to, name, ticketId, title, oldStatus, newStatus, workspaceName }) {
  const senderName = workspaceName || FROM_NAME

  const STATUS_LABELS = {
    open:        'Abierto',
    in_progress: 'En progreso',
    waiting:     'En espera',
    resolved:    'Resuelto',
    closed:      'Cerrado',
  }
  const STATUS_COLORS = {
    open:        '#3b82f6',
    in_progress: '#f97316',
    waiting:     '#a855f7',
    resolved:    '#22c55e',
    closed:      '#6b7280',
  }
  const STATUS_MESSAGES = {
    open:        'Tu solicitud ha sido reabierta y nuestro equipo la revisará nuevamente.',
    in_progress: 'Nuestro equipo ya está trabajando en tu solicitud.',
    waiting:     'Estamos esperando información adicional para continuar con tu caso.',
    resolved:    'Tu solicitud ha sido resuelta. Esperamos haber podido ayudarte.',
    closed:      'Tu solicitud ha sido cerrada.',
  }

  const newLabel   = STATUS_LABELS[newStatus]   || newStatus
  const newColor   = STATUS_COLORS[newStatus]   || '#6b7280'
  const newMessage = STATUS_MESSAGES[newStatus] || 'El estado de tu solicitud ha sido actualizado.'

  return sendMail({
    to,
    fromName: senderName,
    subject: `Tu ticket #${ticketId} ahora está ${newLabel} — ${title}`,
    html: `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <!-- Header -->
        <tr>
          <td style="background:#18181b;padding:28px 32px;">
            <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">${senderName}</p>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:36px 32px;">
            <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#18181b;">Estado de tu solicitud actualizado</h1>
            <p style="margin:0 0 28px;font-size:15px;color:#71717a;line-height:1.6;">
              Hola${name ? ' ' + name : ''}, ${newMessage}
            </p>

            <!-- Ticket ref -->
            <p style="margin:0 0 16px;font-size:12px;font-weight:600;color:#a1a1aa;text-transform:uppercase;letter-spacing:.5px;">
              Ticket #${ticketId} — ${title}
            </p>

            <!-- Status badge -->
            <table cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
              <tr>
                <td style="background:${newColor}1a;border:1px solid ${newColor}40;border-radius:99px;padding:6px 18px;">
                  <p style="margin:0;font-size:14px;font-weight:700;color:${newColor};">${newLabel}</p>
                </td>
              </tr>
            </table>

            <p style="margin:0;font-size:13px;color:#a1a1aa;line-height:1.6;">
              Si tienes alguna duda, contáctanos por el mismo canal donde iniciaste la conversación.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="padding:20px 32px;border-top:1px solid #f4f4f5;">
            <p style="margin:0;font-size:12px;color:#a1a1aa;">© ${new Date().getFullYear()} ${FROM_NAME}. Todos los derechos reservados.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

module.exports = { sendMail, sendPasswordReset, sendEmailVerification, sendTicketConfirmation, sendTicketUpdate, sendTicketStatusChange }
