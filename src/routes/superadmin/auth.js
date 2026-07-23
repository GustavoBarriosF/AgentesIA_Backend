'use strict'

const bcrypt = require('bcrypt')
const SuperAdmin = require('../../db/models/super-admin')
const { errorResponse } = require('../../schemas/common')

const SuperAdminObject = {
  type: 'object',
  properties: {
    _id:        { type: 'string' },
    email:      { type: 'string' },
    name:       { type: 'string' },
    role:       { type: 'string', enum: ['superadmin', 'support'] },
    last_login: { type: 'string', format: 'date-time', nullable: true },
  },
}

async function superAdminAuthRoutes(fastify) {

  // ─── GET /superadmin/auth/setup-status ───────────────────────────────────
  fastify.get('/setup-status', {
    schema: {
      tags: ['SuperAdmin — Auth'],
      summary: 'Verificar si se necesita configuración inicial',
      description: 'Retorna `needs_setup: true` si no existe ningún superadmin. Sin autenticación.',
      response: {
        200: {
          type: 'object',
          properties: {
            needs_setup: { type: 'boolean' },
          },
        },
      },
    },
  }, async () => {
    const count = await SuperAdmin.countDocuments()
    return { needs_setup: count === 0 }
  })

  // ─── POST /superadmin/auth/setup ──────────────────────────────────────────
  fastify.post('/setup', {
    schema: {
      tags: ['SuperAdmin — Auth'],
      summary: 'Crear primer superadmin',
      description: 'Solo funciona si no existe ningún superadmin. Crea la cuenta inicial. Sin autenticación.',
      body: {
        type: 'object',
        required: ['name', 'email', 'password'],
        properties: {
          name:     { type: 'string', minLength: 2 },
          email:    { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            token:      { type: 'string' },
            superAdmin: SuperAdminObject,
          },
        },
        409: { description: 'Ya existe al menos un superadmin', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const count = await SuperAdmin.countDocuments()
    if (count > 0) {
      return reply.code(409).send({ error: 'El sistema ya fue configurado. Usa el login normal.' })
    }

    const { name, email, password } = request.body
    const password_hash = await bcrypt.hash(password, 12)
    const user = await SuperAdmin.create({ name, email: email.toLowerCase(), password_hash, role: 'superadmin' })

    user.last_login = new Date()
    await user.save()

    const token = await fastify.generateSuperAdminToken({
      sub: user._id.toString(),
      email: user.email,
      name: user.name,
      role: user.role,
      isSuperAdmin: true,
    })

    return reply.code(201).send({
      token,
      superAdmin: {
        _id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        last_login: user.last_login,
      },
    })
  })

  // ─── POST /superadmin/auth/login ──────────────────────────────────────────
  fastify.post('/login', {
    schema: {
      tags: ['SuperAdmin — Auth'],
      summary: 'Login superadmin',
      description: 'Autentica un superadmin y retorna un JWT firmado con `SUPERADMIN_JWT_SECRET`. **Completamente separado del auth de workspaces.**',
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string', format: 'email', example: 'admin@NexoraChat.com' },
          password: { type: 'string', example: 'Admin1234!' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            token:      { type: 'string', description: 'JWT de superadmin (8h)' },
            superAdmin: SuperAdminObject,
          },
        },
        401: { description: 'Credenciales incorrectas', ...errorResponse },
        403: { description: 'Cuenta desactivada', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { email, password } = request.body

    const superAdmin = await SuperAdmin.findOne({ email })
    if (!superAdmin) {
      return reply.code(401).send({ error: 'Credenciales invalidas' })
    }

    if (!superAdmin.active) {
      return reply.code(403).send({ error: 'Cuenta de superadmin desactivada' })
    }

    const valid = await bcrypt.compare(password, superAdmin.password_hash)
    if (!valid) {
      return reply.code(401).send({ error: 'Credenciales invalidas' })
    }

    // Actualizar último login
    superAdmin.last_login = new Date()
    await superAdmin.save()

    const token = await fastify.generateSuperAdminToken({
      sub: superAdmin._id.toString(),
      email: superAdmin.email,
      name: superAdmin.name,
      role: superAdmin.role,
      isSuperAdmin: true,
    })

    return {
      token,
      superAdmin: {
        _id: superAdmin._id,
        email: superAdmin.email,
        name: superAdmin.name,
        role: superAdmin.role,
        last_login: superAdmin.last_login,
      },
    }
  })

  // ─── POST /superadmin/auth/logout ─────────────────────────────────────────
  fastify.post('/logout', {
    preHandler: [fastify.authenticateSuperAdmin],
    schema: {
      tags: ['SuperAdmin — Auth'],
      summary: 'Logout superadmin',
      security: [{ BearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
      },
    },
  }, async (request) => {
    const token = request.headers['authorization'].slice(7)
    await fastify.invalidateSuperAdminToken(token)
    return { message: 'Sesion cerrada correctamente' }
  })

  // ─── POST /superadmin/auth/change-password ────────────────────────────────
  fastify.post('/change-password', {
    preHandler: [fastify.authenticateSuperAdmin],
    schema: {
      tags: ['SuperAdmin — Auth'],
      summary: 'Cambiar contraseña superadmin',
      security: [{ BearerAuth: [] }],
      body: {
        type: 'object',
        required: ['current_password', 'new_password'],
        properties: {
          current_password: { type: 'string' },
          new_password:     { type: 'string', minLength: 8 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { message: { type: 'string' } },
        },
        400: { description: 'Contraseña actual incorrecta', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { current_password, new_password } = request.body
    const superAdmin = await SuperAdmin.findById(request.superAdmin.sub)

    const valid = await bcrypt.compare(current_password, superAdmin.password_hash)
    if (!valid) {
      return reply.code(400).send({ error: 'Contrasena actual incorrecta' })
    }

    superAdmin.password_hash = await bcrypt.hash(new_password, 12)
    await superAdmin.save()

    // Invalidar token actual y forzar nuevo login
    const token = request.headers['authorization'].slice(7)
    await fastify.invalidateSuperAdminToken(token)

    return { message: 'Contrasena actualizada. Por favor vuelve a iniciar sesion.' }
  })

  // ─── GET /superadmin/auth/me ──────────────────────────────────────────────
  fastify.get('/me', {
    preHandler: [fastify.authenticateSuperAdmin],
    schema: {
      tags: ['SuperAdmin — Auth'],
      summary: 'Datos del superadmin autenticado',
      security: [{ BearerAuth: [] }],
      response: {
        200: SuperAdminObject,
      },
    },
  }, async (request) => {
    const superAdmin = await SuperAdmin.findById(request.superAdmin.sub).lean()
    return {
      _id: superAdmin._id,
      email: superAdmin.email,
      name: superAdmin.name,
      role: superAdmin.role,
      last_login: superAdmin.last_login,
    }
  })

  // ─── GET /superadmin/auth/users ───────────────────────────────────────────
  fastify.get('/users', {
    preHandler: [fastify.authenticateSuperAdmin],
    schema: {
      tags: ['SuperAdmin — Auth'],
      summary: 'Listar usuarios administradores',
      description: 'Lista todos los usuarios del panel de administración. Accesible para cualquier rol autenticado.',
      security: [{ BearerAuth: [] }],
      response: {
        200: {
          type: 'array',
          items: {
            ...SuperAdminObject,
            properties: {
              ...SuperAdminObject.properties,
              active:     { type: 'boolean' },
              last_login: { type: 'string', format: 'date-time', nullable: true },
              createdAt:  { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
  }, async () => {
    return SuperAdmin.find().select('-password_hash').sort({ createdAt: 1 }).lean()
  })

  // ─── POST /superadmin/auth/users ──────────────────────────────────────────
  fastify.post('/users', {
    preHandler: [fastify.authenticateSuperAdmin, fastify.requireSuperAdminRole],
    schema: {
      tags: ['SuperAdmin — Auth'],
      summary: 'Crear usuario administrador',
      description: 'Crea un nuevo usuario del panel. Solo accesible con rol `superadmin`.',
      security: [{ BearerAuth: [] }],
      body: {
        type: 'object',
        required: ['email', 'password', 'name'],
        properties: {
          email:    { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8 },
          name:     { type: 'string', minLength: 1 },
          role:     { type: 'string', enum: ['superadmin', 'support'], default: 'support' },
        },
      },
      response: {
        201: SuperAdminObject,
        409: { description: 'Email ya registrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { email, password, name, role = 'support' } = request.body

    const existing = await SuperAdmin.findOne({ email: email.toLowerCase() })
    if (existing) {
      return reply.code(409).send({ error: 'Ya existe un usuario con ese email' })
    }

    const password_hash = await bcrypt.hash(password, 12)
    const user = await SuperAdmin.create({ email, password_hash, name, role })

    return reply.code(201).send({
      _id: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      last_login: user.last_login,
    })
  })

  // ─── PATCH /superadmin/auth/users/:userId ─────────────────────────────────
  fastify.patch('/users/:userId', {
    preHandler: [fastify.authenticateSuperAdmin, fastify.requireSuperAdminRole],
    schema: {
      tags: ['SuperAdmin — Auth'],
      summary: 'Actualizar usuario administrador',
      description: 'Actualiza nombre, rol o estado activo. Para cambiar contraseña usa `/change-password`. Solo accesible con rol `superadmin`.',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name:   { type: 'string', minLength: 1 },
          role:   { type: 'string', enum: ['superadmin', 'support'] },
          active: { type: 'boolean' },
        },
      },
      response: {
        200: SuperAdminObject,
        400: { description: 'No puedes modificarte a ti mismo el rol/estado', ...errorResponse },
        404: { description: 'Usuario no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { userId } = request.params
    const { name, role, active } = request.body

    // Evitar que el superadmin se auto-degrade o desactive
    if (userId === request.superAdmin.sub) {
      if (role !== undefined || active === false) {
        return reply.code(400).send({ error: 'No puedes modificar tu propio rol o estado activo' })
      }
    }

    const user = await SuperAdmin.findById(userId)
    if (!user) {
      return reply.code(404).send({ error: 'Usuario no encontrado' })
    }

    if (name   !== undefined) user.name   = name
    if (role   !== undefined) user.role   = role
    if (active !== undefined) user.active = active

    await user.save()

    return {
      _id: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      last_login: user.last_login,
    }
  })

  // ─── DELETE /superadmin/auth/users/:userId ────────────────────────────────
  fastify.delete('/users/:userId', {
    preHandler: [fastify.authenticateSuperAdmin, fastify.requireSuperAdminRole],
    schema: {
      tags: ['SuperAdmin — Auth'],
      summary: 'Eliminar usuario administrador',
      description: 'Elimina permanentemente un usuario del panel. No puedes eliminarte a ti mismo. Solo accesible con rol `superadmin`.',
      security: [{ BearerAuth: [] }],
      params: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string' },
        },
      },
      response: {
        204: { type: 'null', description: 'Usuario eliminado' },
        400: { description: 'No puedes eliminarte a ti mismo', ...errorResponse },
        404: { description: 'Usuario no encontrado', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    const { userId } = request.params

    if (userId === request.superAdmin.sub) {
      return reply.code(400).send({ error: 'No puedes eliminarte a ti mismo' })
    }

    const user = await SuperAdmin.findByIdAndDelete(userId)
    if (!user) {
      return reply.code(404).send({ error: 'Usuario no encontrado' })
    }

    return reply.code(204).send()
  })
}

module.exports = superAdminAuthRoutes
