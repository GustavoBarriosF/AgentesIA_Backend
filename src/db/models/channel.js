'use strict'

const mongoose = require('mongoose')
const { Schema } = mongoose

const channelSchema = new Schema({
  workspace_id: { type: Schema.Types.ObjectId, ref: 'Workspace', required: true },
  name: { type: String, required: true, trim: true },
  type: {
    type: String,
    enum: ['web_widget', 'whatsapp', 'whatsapp_baileys', 'telegram', 'api', 'facebook_messenger', 'instagram_dm', 'email', 'slack', 'teams', 'sms', 'line'],
    required: true,
  },
  config: {
    type: Schema.Types.Mixed,
    default: {},
    // Para type === 'instagram_dm':
    //   page_id: ID de la página de Facebook vinculada
    //   access_token: Page Access Token con permisos de Instagram Messaging
    //   ig_account_id: ID de la cuenta de negocio de Instagram
    //   verify_token: Token de verificación del webhook
    // Para type === 'email':
    //   inbox_address: dirección de email del workspace (ej: soporte@empresa.com)
    //   smtp_host, smtp_port, smtp_user, smtp_password: credenciales SMTP de envío
    //   inbound_provider: 'sendgrid' | 'mailgun' | 'postmark' | 'generic'
    //   inbound_webhook_secret: token para verificar webhooks entrantes
    //   reply_to: dirección reply-to opcional (puede diferir del inbox)
    // Para type === 'web_widget', el campo config.design acepta:
    //   primary_color:          string hex (default: '#6366f1') — color del botón y encabezado
    //   text_color:             string hex (default: '#ffffff') — color del texto del encabezado
    //   position:               'bottom-right' | 'bottom-left' (default: 'bottom-right')
    //   launcher_size:          'small' | 'medium' | 'large' (default: 'medium')
    //   bot_avatar_url:         string URL — avatar del bot en el widget
    //   bot_display_name:       string — nombre en el encabezado
    //   bot_subtitle:           string — subtítulo (ej: 'En línea')
    //   welcome_message:        string — burbuja sobre el launcher cuando está cerrado
    //   show_unread_badge:      boolean (default: true) — mostrar contador de no leídos
    //   launcher_icon:          'chat' | 'help' | 'smile' | 'custom' (default: 'chat')
    //   custom_launcher_icon_url: string URL — ícono personalizado (si launcher_icon === 'custom')
    //   font_family:            'system' | 'inter' | 'roboto' | 'poppins' (default: 'system')
    //   border_radius:          'none' | 'small' | 'medium' | 'large' (default: 'medium')
  },
  active: { type: Boolean, default: true },
}, { timestamps: true })

channelSchema.index({ workspace_id: 1, type: 1 })
channelSchema.index({ workspace_id: 1, active: 1 })

module.exports = mongoose.model('Channel', channelSchema)
