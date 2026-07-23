'use strict'

const Redis = require('ioredis')
const logger = require('../utils/logger')

let redis

function getRedis() {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 10) return null
        return Math.min(times * 100, 3000)
      },
      reconnectOnError(err) {
        return err.message.includes('READONLY')
      },
    })

    redis.on('connect', () => logger.info('Redis conectado'))
    redis.on('error', (err) => logger.error({ err }, 'Error en Redis'))
    redis.on('close', () => logger.warn('Redis conexion cerrada'))
  }
  return redis
}

async function closeRedis() {
  if (redis) {
    await redis.quit()
    redis = null
    logger.info('Redis desconectado correctamente')
  }
}

module.exports = { getRedis, closeRedis }
