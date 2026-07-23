'use strict'

const mongoose = require('mongoose')
const logger = require('../utils/logger')

async function connectDB() {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('MONGODB_URI no definida en variables de entorno')

  await mongoose.connect(uri, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })

  logger.info('MongoDB conectado: %s', mongoose.connection.host)

  mongoose.connection.on('error', (err) => {
    logger.error({ err }, 'Error en conexion MongoDB')
  })

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB desconectado')
  })
}

async function closeDB() {
  await mongoose.connection.close()
  logger.info('MongoDB desconectado correctamente')
}

module.exports = { connectDB, closeDB }
