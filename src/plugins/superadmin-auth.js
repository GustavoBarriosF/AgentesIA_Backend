'use strict'

const fp = require('fastify-plugin')
const { SignJWT, jwtVerify } = require('jose')
const { getRedis } = require('../db/redis')
const crypto = require('crypto')

async function superAdminAuthPlugin(fastify) {
  const secret = new TextEncoder().encode(
    process.env.SUPERADMIN_JWT_SECRET || 'superadmin-dev-secret-change-in-production'
  )

  /**
   * Genera un JWT de superadmin con el payload dado.
   * Firmado con SUPERADMIN_JWT_SECRET — completamente separado del JWT de workspaces.
   */
  fastify.decorate('generateSuperAdminToken', async function(payload) {
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('8h')
      .sign(secret)

    const hash = crypto.createHash('sha256').update(token).digest('hex')
    const redis = getRedis()
    // TTL 8 horas = 28800 segundos
    await redis.set(`sa_session:${hash}`, payload.sub, 'EX', 28800)

    return token
  })

  /**
   * Verifica el JWT de superadmin y adjunta el payload al request.
   * Uso: preHandler: [fastify.authenticateSuperAdmin]
   */
  fastify.decorate('authenticateSuperAdmin', async function(request, reply) {
    const authHeader = request.headers['authorization']
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Token de superadmin requerido' })
    }

    const token = authHeader.slice(7)

    try {
      const { payload } = await jwtVerify(token, secret)

      // Verificar que la sesión existe en Redis
      const hash = crypto.createHash('sha256').update(token).digest('hex')
      const redis = getRedis()
      const sessionExists = await redis.exists(`sa_session:${hash}`)
      if (!sessionExists) {
        return reply.code(401).send({ error: 'Sesion de superadmin invalida o expirada' })
      }

      if (!payload.isSuperAdmin) {
        return reply.code(403).send({ error: 'Acceso restringido a superadmins' })
      }

      request.superAdmin = payload
    } catch {
      return reply.code(401).send({ error: 'Token invalido o expirado' })
    }
  })

  /**
   * Verifica que el superadmin tenga rol 'superadmin' (no solo 'support').
   * Uso: preHandler: [fastify.authenticateSuperAdmin, fastify.requireSuperAdminRole]
   */
  fastify.decorate('requireSuperAdminRole', async function(request, reply) {
    if (request.superAdmin?.role !== 'superadmin') {
      return reply.code(403).send({ error: 'Se requiere rol superadmin' })
    }
  })

  /**
   * Invalida una sesión de superadmin borrando su hash de Redis.
   */
  fastify.decorate('invalidateSuperAdminToken', async function(token) {
    const hash = crypto.createHash('sha256').update(token).digest('hex')
    const redis = getRedis()
    await redis.del(`sa_session:${hash}`)
  })
}

module.exports = fp(superAdminAuthPlugin, { name: 'superadmin-auth' })
