'use strict'

const fp = require('fastify-plugin')
const { SignJWT, jwtVerify } = require('jose')
const { getRedis } = require('../db/redis')
const crypto = require('crypto')

async function authPlugin(fastify) {
  const secret = new TextEncoder().encode(process.env.JWT_SECRET || 'dev-secret-change-in-production')

  /**
   * Genera un token JWT con payload dado
   */
  fastify.decorate('generateToken', async function(payload) {
    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(process.env.JWT_EXPIRES_IN || '24h')
      .sign(secret)

    // Guardar sesion en Redis
    const hash = crypto.createHash('sha256').update(token).digest('hex')
    const redis = getRedis()
    await redis.set(`session:${hash}`, payload.sub, 'EX', 86400)

    return token
  })

  /**
   * Verifica el token y adjunta el payload al request.
   * Uso: preHandler: [fastify.authenticate]
   */
  fastify.decorate('authenticate', async function(request, reply) {
    const authHeader = request.headers['authorization']
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Token requerido' })
    }

    const token = authHeader.slice(7)

    try {
      const { payload } = await jwtVerify(token, secret)

      // Verificar que la sesion existe en Redis
      const hash = crypto.createHash('sha256').update(token).digest('hex')
      const redis = getRedis()
      const sessionExists = await redis.exists(`session:${hash}`)
      if (!sessionExists) {
        return reply.code(401).send({ error: 'Sesion invalida o expirada' })
      }

      request.user = payload
    } catch (err) {
      return reply.code(401).send({ error: 'Token invalido o expirado' })
    }
  })

  /**
   * Invalida un token borrando su sesion de Redis
   */
  fastify.decorate('invalidateToken', async function(token) {
    const hash = crypto.createHash('sha256').update(token).digest('hex')
    const redis = getRedis()
    await redis.del(`session:${hash}`)
  })
}

module.exports = fp(authPlugin, { name: 'auth' })
