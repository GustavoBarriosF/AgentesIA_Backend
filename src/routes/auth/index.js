'use strict'

const authService = require('../../services/auth.service')
const { errorResponse, validationError, security } = require('../../schemas/common')

// ─── Schemas de respuesta reutilizables ────────────────────────────────────────

const UserObject = {
  type: 'object',
  properties: {
    _id:        { type: 'string' },
    name:       { type: 'string' },
    email:      { type: 'string', format: 'email' },
    avatar_url: { type: 'string', nullable: true },
  },
}

const WorkspaceObject = {
  type: 'object',
  properties: {
    id:   { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
  },
}

const TokenResponse = {
  type: 'object',
  properties: {
    token: { type: 'string', description: 'JWT de acceso — incluirlo como Bearer en Authorization' },
  },
}

async function authRoutes(fastify) {
  // ─── POST /auth/register ──────────────────────────────────────────────────
  fastify.post('/register', {
    schema: {
      tags: ['Auth'],
      summary: 'Registrar nuevo usuario',
      description: 'Crea un usuario y su workspace inicial. En **desarrollo** el email se verifica automáticamente.',
      body: {
        type: 'object',
        required: ['name', 'email', 'password'],
        properties: {
          name:     { type: 'string', minLength: 2, maxLength: 80, description: 'Nombre completo', example: 'Carlos García' },
          email:    { type: 'string', format: 'email', description: 'Email del usuario', example: 'carlos@empresa.com' },
          password: { type: 'string', minLength: 8, description: 'Contraseña (mín. 8 caracteres)', example: 'MiPass123!' },
        },
      },
      response: {
        201: {
          description: 'Usuario registrado correctamente',
          type: 'object',
          properties: {
            token: { type: 'string', description: 'JWT de acceso' },
            user:  UserObject,
            workspaces: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  workspace: {
                    type: 'object',
                    properties: {
                      _id:      { type: 'string' },
                      name:     { type: 'string' },
                      slug:     { type: 'string' },
                      branding: { type: 'object', additionalProperties: true },
                    },
                  },
                  role: { type: 'string', enum: ['owner', 'admin', 'agent', 'viewer'] },
                },
              },
            },
          },
        },
        400: { description: 'Datos inválidos', ...validationError },
        409: { description: 'Email ya registrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { name, email, password } = request.body
    const { user, workspace } = await authService.register({ name, email, password })

    if (process.env.NODE_ENV === 'development') {
      user.verified = true
      await user.save()
    }

    const tokenWorkspaces = [{ id: workspace._id.toString(), role: 'owner' }]
    const token = await fastify.generateToken({ sub: user._id.toString(), email: user.email, workspaces: tokenWorkspaces })

    const workspaces = [{
      workspace: { _id: workspace._id, name: workspace.name, slug: workspace.slug, branding: {} },
      role: 'owner',
    }]

    return reply.code(201).send({
      token,
      user:       { _id: user._id, name: user.name, email: user.email },
      workspaces,
    })
  })

  // ─── POST /auth/login ─────────────────────────────────────────────────────
  fastify.post('/login', {
    schema: {
      tags: ['Auth'],
      summary: 'Iniciar sesión',
      description: 'Autentica credenciales y retorna un **JWT** + lista de workspaces del usuario.',
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string', format: 'email', example: 'carlos@empresa.com' },
          password: { type: 'string', example: 'MiPass123!' },
        },
      },
      response: {
        200: {
          description: 'Login exitoso',
          type: 'object',
          properties: {
            token: { type: 'string', description: 'JWT — úsalo como Bearer token' },
            user:  UserObject,
            workspaces: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  workspace: {
                    type: 'object',
                    properties: {
                      _id:      { type: 'string' },
                      name:     { type: 'string' },
                      slug:     { type: 'string' },
                      branding: { type: 'object', additionalProperties: true },
                    },
                  },
                  role: { type: 'string', enum: ['owner', 'admin', 'agent', 'viewer'] },
                },
              },
            },
          },
        },
        401: { description: 'Credenciales incorrectas', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body
    const { user, workspaces } = await authService.login({ email, password })
    // Token payload usa solo ids para mantenerlo pequeño
    const tokenWorkspaces = workspaces.map(w => ({ id: w.workspace._id.toString(), role: w.role }))
    const token = await fastify.generateToken({ sub: user._id.toString(), email: user.email, workspaces: tokenWorkspaces })
    return {
      token,
      user: { _id: user._id, name: user.name, email: user.email, avatar_url: user.avatar_url },
      workspaces,
    }
  })

  // ─── POST /auth/logout ────────────────────────────────────────────────────
  fastify.post('/logout', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Auth'],
      summary: 'Cerrar sesión',
      description: 'Invalida el token actual en Redis.',
      security,
      response: {
        200: {
          description: 'Sesión cerrada',
          type: 'object',
          properties: { message: { type: 'string' } },
        },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const token = request.headers['authorization'].slice(7)
    await fastify.invalidateToken(token)
    return { message: 'Sesion cerrada correctamente' }
  })

  // ─── POST /auth/refresh ───────────────────────────────────────────────────
  fastify.post('/refresh', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Auth'],
      summary: 'Refrescar token JWT',
      description: 'Invalida el token actual y genera uno nuevo con los mismos permisos.',
      security,
      response: {
        200: {
          description: 'Nuevo token generado',
          ...TokenResponse,
        },
        401: { description: 'Token inválido o expirado', ...errorResponse },
      },
    },
  }, async (request) => {
    const oldToken = request.headers['authorization'].slice(7)
    await fastify.invalidateToken(oldToken)
    const { sub, email, workspaces } = request.user
    const token = await fastify.generateToken({ sub, email, workspaces })
    return { token }
  })

  // ─── POST /auth/forgot-password ───────────────────────────────────────────
  fastify.post('/forgot-password', {
    schema: {
      tags: ['Auth'],
      summary: 'Solicitar reset de contraseña',
      description: 'Envía un email con enlace de reset si el email existe. **Siempre retorna 200** para no revelar si el email está registrado.',
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email', example: 'carlos@empresa.com' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
      },
    },
  }, async (request) => {
    await authService.forgotPassword(request.body.email)
    return { message: 'Si el email existe, recibiras un enlace de recuperacion' }
  })

  // ─── POST /auth/reset-password ────────────────────────────────────────────
  fastify.post('/reset-password', {
    schema: {
      tags: ['Auth'],
      summary: 'Resetear contraseña',
      description: 'Cambia la contraseña usando el token recibido por email.',
      body: {
        type: 'object',
        required: ['token', 'password'],
        properties: {
          token:    { type: 'string', description: 'Token del email de reset' },
          password: { type: 'string', minLength: 8, example: 'NuevoPass456!' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
        400: { description: 'Token inválido o expirado', ...errorResponse },
      },
    },
  }, async (request) => {
    await authService.resetPassword(request.body.token, request.body.password)
    return { message: 'Contrasena actualizada correctamente' }
  })

  // ─── GET /auth/me ─────────────────────────────────────────────────────────
  fastify.get('/me', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Auth'],
      summary: 'Obtener perfil del usuario autenticado',
      security,
      response: {
        200: {
          type: 'object',
          properties: {
            user: UserObject,
          },
        },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const User = require('../../db/models/user')
    const user = await User.findById(request.user.sub).lean()
    if (!user) throw Object.assign(new Error('Usuario no encontrado'), { statusCode: 404 })
    return {
      user: { _id: user._id, name: user.name, email: user.email, avatar_url: user.avatar_url },
    }
  })

  // ─── PATCH /auth/me ───────────────────────────────────────────────────────
  fastify.patch('/me', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Auth'],
      summary: 'Actualizar perfil del usuario autenticado',
      security,
      body: {
        type: 'object',
        properties: {
          name:       { type: 'string', minLength: 2, maxLength: 80 },
          avatar_url: { type: 'string', nullable: true },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { user: UserObject },
        },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const User = require('../../db/models/user')
    const { name, avatar_url } = request.body
    const updates = {}
    if (name       !== undefined) updates.name       = name.trim()
    if (avatar_url !== undefined) updates.avatar_url = avatar_url

    const user = await User.findByIdAndUpdate(
      request.user.sub,
      { $set: updates },
      { new: true, runValidators: true }
    ).lean()
    if (!user) throw Object.assign(new Error('Usuario no encontrado'), { statusCode: 404 })

    return {
      user: { _id: user._id, name: user.name, email: user.email, avatar_url: user.avatar_url },
    }
  })

  // ─── POST /auth/me/password ───────────────────────────────────────────────
  fastify.post('/me/password', {
    preHandler: [fastify.authenticate],
    schema: {
      tags: ['Auth'],
      summary: 'Cambiar contraseña del usuario autenticado',
      security,
      body: {
        type: 'object',
        required: ['current_password', 'new_password'],
        properties: {
          current_password: { type: 'string', minLength: 1 },
          new_password:     { type: 'string', minLength: 8 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
        400: { description: 'Contraseña actual incorrecta', ...errorResponse },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const User = require('../../db/models/user')
    const bcrypt = require('bcrypt')
    const { current_password, new_password } = request.body

    const user = await User.findById(request.user.sub)
    if (!user) throw Object.assign(new Error('Usuario no encontrado'), { statusCode: 404 })

    const valid = await bcrypt.compare(current_password, user.password_hash)
    if (!valid) throw Object.assign(new Error('La contraseña actual es incorrecta'), { statusCode: 400 })

    user.password_hash = await bcrypt.hash(new_password, 12)
    await user.save()

    return { message: 'Contraseña actualizada correctamente' }
  })

  // ─── POST /auth/resend-verification ──────────────────────────────────────
  fastify.post('/resend-verification', {
    schema: {
      tags: ['Auth'],
      summary: 'Reenviar email de verificación',
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
        },
      },
      response: {
        200: { type: 'object', properties: { message: { type: 'string' } } },
      },
    },
  }, async (request) => {
    // Siempre responder 200 para no revelar si el email existe
    await authService.resendVerification(request.body.email).catch(() => {})
    return { message: 'Si el email existe y no está verificado, recibirás el enlace.' }
  })

  // ─── GET /auth/verify-email/:token ────────────────────────────────────────
  fastify.get('/verify-email/:token', {
    schema: {
      tags: ['Auth'],
      summary: 'Verificar email',
      description: 'Activa la cuenta con el token recibido por email al registrarse.',
      params: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', description: 'Token de verificación enviado por email' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
        400: { description: 'Token inválido', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001'
    try {
      await authService.verifyEmail(request.params.token)
      return reply.redirect(`${frontendUrl}/login?verified=true`)
    } catch {
      return reply.redirect(`${frontendUrl}/login?verified=false`)
    }
  })
}

module.exports = authRoutes
