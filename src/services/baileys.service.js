'use strict'

const path = require('path')
const fs   = require('fs')
const { processIncomingMessage } = require('./incoming-message.service')
const Channel = require('../db/models/channel')
const Message = require('../db/models/message')
const logger  = require('../utils/logger')

// Mensajes de rechazo para tipos de medios no soportados
const UNSUPPORTED_AUDIO_VIDEO = '⚠️ Este canal no soporta mensajes de audio ni video. Por favor envía tu consulta en texto.'
const UNSUPPORTED_MEDIA = '⚠️ Este canal no soporta este tipo de archivo. Por favor envía tu consulta en texto.'

// Mapa en memoria: channelId → { sock, status, qr, phone, reconnectTimer }
const connections = new Map()

// Referencia global a fastify (se inyecta en init)
let _fastify = null

const SESSIONS_DIR = path.join(__dirname, '../../sessions/baileys')

function ensureSessionDir(channelId) {
  const dir = path.join(SESSIONS_DIR, channelId)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Inyecta la instancia de Fastify. Llamar al iniciar la app.
 */
function init(fastify) {
  _fastify = fastify
}

/**
 * Inicia la conexión Baileys para un canal. Idempotente.
 */
async function connect(channelId, workspaceId) {
  if (!_fastify) throw new Error('Baileys service not initialized')

  // Si ya hay una conexión activa, no re-conectar
  const existing = connections.get(channelId)
  if (existing && ['connecting', 'qr_ready', 'connected'].includes(existing.status)) {
    return { status: existing.status }
  }

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = require('@whiskeysockets/baileys')

  const QRCode = require('qrcode')
  const pino   = require('pino')

  const sessionDir = ensureSessionDir(channelId)

  // Estado de la conexión
  connections.set(channelId, { status: 'connecting', qr: null, phone: null, sock: null, workspaceId, reconnectTimer: null })

  logger.info({ channelId, workspaceId }, '[Baileys] Iniciando conexión')

  async function startConnection() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
    const { version } = await fetchLatestBaileysVersion()

    const conn = connections.get(channelId)
    if (conn?.reconnectTimer) clearTimeout(conn.reconnectTimer)

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['TrivoxChat', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 30_000,
      keepAliveIntervalMs: 25_000,
    })

    connections.set(channelId, { ...connections.get(channelId), sock })

    // ── Credenciales: guardar cuando cambian ────────────────────────────────
    sock.ev.on('creds.update', saveCreds)

    // ── Estado de la conexión ───────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update
      const conn = connections.get(channelId)
      if (!conn) return

      if (qr) {
        try {
          const qrDataUrl = await QRCode.toDataURL(qr, { width: 256, margin: 2 })
          connections.set(channelId, { ...conn, status: 'qr_ready', qr: qrDataUrl })
          logger.info({ channelId }, '[Baileys] QR generado')

          // Emitir QR al dashboard del workspace via WebSocket
          _fastify?.io?.to(`workspace:${workspaceId}`).emit('baileys:qr', {
            channelId,
            qr: qrDataUrl,
          })
        } catch (err) {
          logger.error({ err: err.message }, '[Baileys] Error generando QR data URL')
        }
      }

      if (connection === 'open') {
        const phone = sock.user?.id?.split(':')[0] || sock.user?.id || null
        connections.set(channelId, { ...connections.get(channelId), status: 'connected', qr: null, phone })
        logger.info({ channelId, phone }, '[Baileys] Conectado')

        _fastify?.io?.to(`workspace:${workspaceId}`).emit('baileys:connected', { channelId, phone })

        // Asegurar canal activo en BD
        await Channel.updateOne({ _id: channelId }, { active: true }).catch(() => {})
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const loggedOut  = statusCode === DisconnectReason.loggedOut

        if (loggedOut) {
          logger.info({ channelId }, '[Baileys] Sesión cerrada (logout)')
          connections.set(channelId, { ...connections.get(channelId), status: 'disconnected', qr: null, sock: null })
          _fastify?.io?.to(`workspace:${workspaceId}`).emit('baileys:disconnected', { channelId, reason: 'logged_out' })
          // Limpiar sesión guardada para forzar nuevo QR
          clearSession(channelId)
        } else {
          logger.warn({ channelId, statusCode }, '[Baileys] Conexión cerrada — reintentando en 5s')
          connections.set(channelId, { ...connections.get(channelId), status: 'reconnecting', qr: null, sock: null })
          _fastify?.io?.to(`workspace:${workspaceId}`).emit('baileys:disconnected', { channelId, reason: 'lost' })

          const timer = setTimeout(() => startConnection(), 5_000)
          const c = connections.get(channelId)
          if (c) connections.set(channelId, { ...c, reconnectTimer: timer })
        }
      }
    })

    // ── Mensajes entrantes ──────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return

      for (const msg of messages) {
        // Ignorar mensajes propios
        if (msg.key.fromMe) continue

        const jid  = msg.key.remoteJid || ''
        // Ignorar grupos
        if (jid.endsWith('@g.us')) continue

        // Ignorar notificaciones de sistema de WhatsApp (eventos de grupo, protocolo, etc.)
        if (msg.messageStubType) continue

        const senderPhone = jid.replace('@s.whatsapp.net', '').replace('@c.us', '')
        const msgId       = msg.key.id || null

        // Nombre del remitente
        const name = msg.pushName || senderPhone

        const msgContent = msg.message

        if (!msgContent) continue

        // Detectar tipo de mensaje
        const msgType = detectMessageType(msgContent)

        // Ignorar mensajes de protocolo interno de WhatsApp (reacciones, sync, etc.)
        if (msgType === 'protocol') continue

        // Manejar mensajes no soportados
        if (msgType === 'audio' || msgType === 'video') {
          // Verificar deduplicación antes de enviar auto-reply (evita respuestas duplicadas al reconectar)
          const alreadySent = msgId ? await Message.exists({ channel_message_id: msgId }) : false
          if (!alreadySent) {
            await sock.sendMessage(jid, { text: UNSUPPORTED_AUDIO_VIDEO })
          }
          await processIncomingMessage(_fastify, {
            workspaceId,
            channelId,
            channelRef:      senderPhone,
            channelType:     'whatsapp_baileys',
            name,
            text:            `[${msgType === 'audio' ? 'Audio' : 'Video'} — no soportado]`,
            channelMessageId: msgId,
          })
          continue
        }

        if (msgType === 'unsupported') {
          logger.debug({ channelId, jid, msgKeys: Object.keys(msgContent) }, '[Baileys] Tipo de mensaje no reconocido — saltando silenciosamente')
          continue
        }

        // Extraer texto según tipo
        const text = extractText(msgContent, msgType)
        logger.info({ channelId, senderPhone, msgType, textLen: text?.length, msgId }, '[Baileys] Mensaje de texto recibido')
        if (!text) {
          logger.warn({ channelId, msgType, msgContent: JSON.stringify(msgContent).slice(0, 200) }, '[Baileys] Texto vacío — saltando mensaje')
          continue
        }

        await processIncomingMessage(_fastify, {
          workspaceId,
          channelId,
          channelRef:       senderPhone,
          channelType:      'whatsapp_baileys',
          name,
          text,
          channelMessageId: msgId,
          metadata:         { baileys_msg_type: msgType },
        }).catch(async (err) => {
          logger.error({ err: err.message, channelId }, '[Baileys] Error procesando mensaje entrante')
          if (err.statusCode === 402) {
            await sock.sendMessage(jid, { text: '⚠️ Lo sentimos, no podemos atender nuevas conversaciones en este momento. Por favor intenta más tarde.' }).catch(() => {})
          }
        })
      }
    })
  }

  await startConnection()
  return { status: 'connecting' }
}

/**
 * Desconecta y limpia la sesión del canal.
 */
async function disconnect(channelId) {
  const conn = connections.get(channelId)
  if (conn?.sock) {
    try { await conn.sock.logout() } catch { /* puede fallar si ya está desconectado */ }
    try { conn.sock.end(undefined) } catch { /* ignorar */ }
  }
  if (conn?.reconnectTimer) clearTimeout(conn.reconnectTimer)
  connections.delete(channelId)
  clearSession(channelId)
  logger.info({ channelId }, '[Baileys] Sesión desconectada y limpiada')
}

/**
 * Estado actual de una conexión.
 */
function getStatus(channelId) {
  const conn = connections.get(channelId)
  if (!conn) return { status: 'disconnected', qr: null, phone: null }
  return { status: conn.status, qr: conn.qr, phone: conn.phone }
}

/**
 * Envía un mensaje de texto a través de Baileys.
 */
async function sendMessage(channelId, to, message) {
  const conn = connections.get(channelId)
  if (!conn || conn.status !== 'connected' || !conn.sock) {
    throw Object.assign(new Error('WhatsApp (Baileys) no está conectado'), { statusCode: 503 })
  }

  const jid  = to.includes('@') ? to : `${to}@s.whatsapp.net`
  const text = message.content || ''

  await conn.sock.sendMessage(jid, { text })
}

/**
 * Restaura todas las sesiones guardadas al iniciar el servidor.
 * Llamar después de que la DB esté conectada.
 */
async function restoreAllSessions() {
  try {
    const channels = await Channel.find({ type: 'whatsapp_baileys', active: true }).lean()
    if (!channels.length) return

    logger.info({ count: channels.length }, '[Baileys] Restaurando sesiones')

    for (const ch of channels) {
      const sessionDir = path.join(SESSIONS_DIR, ch._id.toString())
      // Solo restaurar si hay sesión guardada (evitar QR innecesario al arrancar)
      if (fs.existsSync(path.join(sessionDir, 'creds.json'))) {
        connect(ch._id.toString(), ch.workspace_id.toString()).catch(err =>
          logger.error({ err: err.message, channelId: ch._id }, '[Baileys] Error restaurando sesión')
        )
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, '[Baileys] Error en restoreAllSessions')
  }
}

// ─── Helpers privados ─────────────────────────────────────────────────────────

function clearSession(channelId) {
  const dir = path.join(SESSIONS_DIR, channelId)
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* ignorar */ }
}

function detectMessageType(msgContent) {
  // Mensajes de protocolo interno — nunca son mensajes reales del usuario
  if (
    msgContent.protocolMessage          ||  // deletions, read receipts, ephemeral timers
    msgContent.reactionMessage          ||  // reacciones con emoji
    msgContent.pollUpdateMessage        ||  // votos en encuestas
    msgContent.senderKeyDistributionMessage || // distribución de claves de cifrado
    msgContent.keepInChatMessage        ||  // anclar mensajes
    msgContent.appStateSyncKeyShare     ||  // sincronización de estado
    msgContent.appStateSyncKeyRequest       // sincronización de estado
  ) return 'protocol'

  if (msgContent.conversation || msgContent.extendedTextMessage) return 'text'
  if (msgContent.imageMessage)    return 'image'
  if (msgContent.documentMessage) return 'file'
  if (msgContent.audioMessage)    return 'audio'
  if (msgContent.videoMessage)    return 'video'
  if (msgContent.stickerMessage)  return 'sticker'
  if (msgContent.locationMessage) return 'location'
  if (msgContent.contactMessage)  return 'contact'
  if (msgContent.listMessage || msgContent.buttonsMessage || msgContent.templateButtonReplyMessage) return 'interactive'
  return 'unsupported'
}

function extractText(msgContent, msgType) {
  switch (msgType) {
    case 'text':
      return msgContent.conversation || msgContent.extendedTextMessage?.text || ''
    case 'image':
      return msgContent.imageMessage?.caption || '[Imagen]'
    case 'file':
      return `[Archivo: ${msgContent.documentMessage?.fileName || 'documento'}]`
    case 'sticker':
      return '[Sticker]'
    case 'location': {
      const loc = msgContent.locationMessage
      return `[Ubicación: ${loc?.degreesLatitude?.toFixed(4)}, ${loc?.degreesLongitude?.toFixed(4)}]`
    }
    case 'contact':
      return `[Contacto: ${msgContent.contactMessage?.displayName || 'contacto'}]`
    case 'interactive':
      return msgContent.listMessage?.title || msgContent.buttonsMessage?.contentText ||
             msgContent.templateButtonReplyMessage?.selectedDisplayText || '[Respuesta interactiva]'
    default:
      return ''
  }
}

module.exports = { init, connect, disconnect, getStatus, sendMessage, restoreAllSessions }
