'use strict'

const bcrypt = require('bcrypt')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const User = require('../db/models/user')
const Workspace = require('../db/models/workspace')
const WorkspaceMember = require('../db/models/workspace-member')
const Plan = require('../db/models/plan')
const Channel = require('../db/models/channel')
const { getRedis } = require('../db/redis')
const mailer = require('./mailer.service')

const SALT_ROUNDS = 12

/**
 * Retorna true si la verificación de email debe omitirse.
 * Esto ocurre cuando:
 *   - NODE_ENV=development
 *   - SKIP_EMAIL_VERIFICATION=true  (variable de entorno explícita)
 *   - El proveedor de email no está configurado (sin API key)
 */
function isEmailVerificationSkipped() {
  if (process.env.NODE_ENV === 'development') return true
  if (process.env.SKIP_EMAIL_VERIFICATION === 'true') return true
  const provider = process.env.EMAIL_PROVIDER || 'resend'
  if (provider === 'resend') {
    const key = process.env.RESEND_API_KEY || ''
    return !key || key.startsWith('re_...')
  }
  if (provider === 'sendgrid') {
    return !process.env.SENDGRID_API_KEY
  }
  return true
}

async function register({ name, email, password }) {
  const existing = await User.findOne({ email })
  if (existing) throw Object.assign(new Error('El email ya esta registrado'), { statusCode: 409 })

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS)
  const verification_token = crypto.randomBytes(32).toString('hex')

  const user = await User.create({ name, email, password_hash, provider: 'local', verification_token })

  // Crear workspace inicial
  const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const slug = `${slugBase}-${uuidv4().slice(0, 6)}`

  const workspace = await Workspace.create({ name, slug })
  await WorkspaceMember.create({ workspace_id: workspace._id, user_id: user._id, role: 'owner' })
  await Plan.create({ workspace_id: workspace._id, tier: 'free' })
  await Channel.create({ workspace_id: workspace._id, name: 'Widget Web', type: 'web_widget', config: { allowed_domains: [] } })

  if (isEmailVerificationSkipped()) {
    // Email no configurado o verificación desactivada: auto-verificar
    user.verified = true
    user.verification_token = null
    await user.save()
  } else {
    // Enviar email de verificación
    mailer.sendEmailVerification({ to: user.email, name: user.name, token: verification_token }).catch(() => {})
  }

  return { user, workspace }
}

async function login({ email, password }) {
  const user = await User.findOne({ email })
  if (!user) throw Object.assign(new Error('Credenciales invalidas'), { statusCode: 401 })
  if (user.provider !== 'local') throw Object.assign(new Error('Usa tu proveedor de login externo'), { statusCode: 400 })
  if (!user.verified && !isEmailVerificationSkipped()) {
    throw Object.assign(new Error('Email no verificado. Revisa tu bandeja de entrada.'), { statusCode: 403 })
  }

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) throw Object.assign(new Error('Credenciales invalidas'), { statusCode: 401 })

  const memberships = await WorkspaceMember.find({ user_id: user._id, active: true })
    .populate('workspace_id', 'name slug branding')
    .lean()

  const workspaces = memberships.map(m => ({
    workspace: {
      _id: m.workspace_id._id,
      name: m.workspace_id.name,
      slug: m.workspace_id.slug,
      branding: m.workspace_id.branding ?? {},
    },
    role: m.role,
  }))

  return { user, workspaces }
}

async function logout(token) {
  // La invalidacion real la hace fastify.invalidateToken en la ruta
  // Este servicio puede hacer limpieza adicional si es necesario
}

async function forgotPassword(email) {
  const user = await User.findOne({ email })
  if (!user) return // No revelar si el email existe

  const token = crypto.randomBytes(32).toString('hex')
  const expires = new Date(Date.now() + 3600 * 1000) // 1 hora

  user.reset_token = token
  user.reset_token_expires = expires
  await user.save()

  const redis = getRedis()
  await redis.set(`reset:${token}`, user._id.toString(), 'EX', 3600)

  // Enviar email (sin await para no bloquear la respuesta si falla)
  mailer.sendPasswordReset({ to: user.email, name: user.name, token }).catch(() => {})

  return { token, user }
}

async function resetPassword(token, newPassword) {
  const redis = getRedis()
  const userId = await redis.get(`reset:${token}`)
  if (!userId) throw Object.assign(new Error('Token invalido o expirado'), { statusCode: 400 })

  const user = await User.findById(userId)
  if (!user) throw Object.assign(new Error('Usuario no encontrado'), { statusCode: 404 })

  user.password_hash = await bcrypt.hash(newPassword, SALT_ROUNDS)
  user.reset_token = null
  user.reset_token_expires = null
  await user.save()

  await redis.del(`reset:${token}`)
  return user
}

async function resendVerification(email) {
  const user = await User.findOne({ email, verified: false })
  if (!user) return // No revelar si el email existe o ya está verificado

  // Generar nuevo token si no tiene uno
  if (!user.verification_token) {
    user.verification_token = require('crypto').randomBytes(32).toString('hex')
    await user.save()
  }

  await mailer.sendEmailVerification({ to: user.email, name: user.name, token: user.verification_token })
}

async function verifyEmail(token) {
  const user = await User.findOne({ verification_token: token })
  if (!user) throw Object.assign(new Error('Token invalido'), { statusCode: 400 })

  user.verified = true
  user.verification_token = null
  await user.save()
  return user
}

module.exports = { register, login, logout, forgotPassword, resetPassword, verifyEmail, resendVerification }
