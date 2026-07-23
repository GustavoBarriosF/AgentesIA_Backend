'use strict'

const fp = require('fastify-plugin')
const swagger = require('@fastify/swagger')
const swaggerUi = require('@fastify/swagger-ui')

async function swaggerPlugin(fastify) {
  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'NexoraChat API',
        description: [
          '## API REST de NexoraChat',
          '',
          'Plataforma de comunicación multicanal con IA — similar a Cliengo / Komunicate.',
          '',
          '### Autenticación',
          'La mayoría de endpoints requieren un **Bearer JWT** obtenido en `POST /auth/login`.',
          'Haz clic en el botón **Authorize 🔒** e ingresa: `<tu_token>`',
          '',
          '### Multitenancy',
          'Todos los endpoints de negocio están bajo `/api/:workspaceId/...`.',
          'El `workspaceId` se obtiene en la respuesta del login.',
          '',
          '### Canales WhatsApp (SaaS)',
          'Cada cliente configura su **propia Meta App**.',
          'Las credenciales (`phone_number_id`, `access_token`, `app_secret`, `verify_token`)',
          'se guardan en `channel.config` — no son variables de entorno globales.',
        ].join('\n'),
        version: '1.0.0',
        contact: {
          name: 'NexoraChat Dev',
          email: 'dev@NexoraChat.com',
        },
        license: {
          name: 'MIT',
        },
      },
      servers: [
        {
          url: `http://localhost:${process.env.PORT || 3000}`,
          description: 'Desarrollo local',
        },
      ],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Token JWT obtenido en **POST /auth/login**',
          },
        },
        schemas: {
          Error: {
            type: 'object',
            properties: {
              error: { type: 'string', description: 'Mensaje de error' },
            },
          },
          ValidationError: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              details: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      },
      tags: [
        { name: 'Health',         description: '🟢 Estado del servidor' },
        { name: 'Auth',           description: '🔐 Autenticación y gestión de sesiones' },
        { name: 'Workspaces',     description: '🏢 Workspaces y miembros del equipo' },
        { name: 'Channels',       description: '📡 Canales de comunicación (WhatsApp, Telegram, Web Widget, API)' },
        { name: 'Agents',         description: '👤 Agentes humanos y disponibilidad' },
        { name: 'Contacts',       description: '📋 Contactos / clientes finales' },
        { name: 'Conversations',  description: '💬 Conversaciones multicanal' },
        { name: 'Messages',       description: '✉️  Mensajes dentro de una conversación' },
        { name: 'Knowledge',      description: '🧠 Base de conocimiento para el bot IA' },
        { name: 'Tickets',        description: '🎫 Sistema de tickets de soporte' },
        { name: 'Leads',          description: '💰 Pipeline de ventas / CRM' },
        { name: 'Analytics',      description: '📊 Métricas y reportes' },
        { name: 'Plans',          description: '💳 Planes y facturación (Stripe)' },
        { name: 'Webhooks',       description: '🔔 Webhooks entrantes (Meta, Telegram, Stripe)' },
      ],
    },
  })

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: true,
      requestSnippetsEnabled: true,
      persistAuthorization: true,
      syntaxHighlight: { activated: true, theme: 'monokai' },
    },
    staticCSP: false,
  })
}

module.exports = fp(swaggerPlugin, { name: 'swagger' })
