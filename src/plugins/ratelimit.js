'use strict'

const fp = require('fastify-plugin')
const rateLimit = require('@fastify/rate-limit')
const { getRedis } = require('../db/redis')

async function rateLimitPlugin(fastify) {
  await fastify.register(rateLimit, {
    global: true,
    max: 200,
    timeWindow: '1 minute',
    redis: getRedis(),
    keyGenerator: (request) => {
      return request.ip + ':' + (request.routeOptions?.url || request.url)
    },
    errorResponseBuilder: () => ({
      error: 'Demasiadas peticiones. Intenta de nuevo en un momento.',
      statusCode: 429,
    }),
  })

  // Rate limit mas estricto para /auth/login (anti brute-force)
  fastify.addHook('onRoute', (routeOptions) => {
    if (routeOptions.url === '/auth/login') {
      routeOptions.config = routeOptions.config || {}
      routeOptions.config.rateLimit = {
        max: 10,
        timeWindow: '1 minute',
      }
    }
    if (routeOptions.url === '/auth/forgot-password') {
      routeOptions.config = routeOptions.config || {}
      routeOptions.config.rateLimit = {
        max: 5,
        timeWindow: '15 minutes',
      }
    }
  })
}

module.exports = fp(rateLimitPlugin, { name: 'ratelimit' })
