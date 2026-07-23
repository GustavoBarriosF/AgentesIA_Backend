'use strict'

const contactService = require('../../services/contact.service')
const { workspaceParam, paginationQuery, errorResponse, security } = require('../../schemas/common')

const ContactObject = {
  type: 'object',
  properties: {
    _id:               { type: 'string' },
    workspace_id:      { type: 'string' },
    name:              { type: 'string' },
    email:             { type: 'string', format: 'email', nullable: true },
    phone:             { type: 'string', nullable: true },
    avatar_url:        { type: 'string', nullable: true },
    channel_ref:       { type: 'string', description: 'ID del contacto en el canal externo (ej: número de WhatsApp)' },
    channel_type:      { type: 'string', enum: ['web_widget', 'whatsapp', 'telegram', 'api'] },
    custom_fields:     { type: 'object', description: 'Campos personalizados definidos por el workspace' },
    conversation_count:{ type: 'integer' },
    last_seen:         { type: 'string', format: 'date-time', nullable: true },
    createdAt:         { type: 'string', format: 'date-time' },
    updatedAt:         { type: 'string', format: 'date-time' },
  },
}

async function contactRoutes(fastify) {
  const preHandler = [fastify.authenticate, fastify.requireWorkspace]

  // ─── GET /api/:workspaceId/contacts ───────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Contacts'],
      summary: 'Listar contactos',
      description: 'Retorna contactos paginados con búsqueda opcional por nombre, email o teléfono.',
      security,
      params: workspaceParam,
      querystring: {
        type: 'object',
        properties: {
          ...paginationQuery,
          search: {
            type: 'string',
            description: 'Busca en nombre, email y teléfono',
            example: 'carlos',
          },
        },
      },
      response: {
        200: {
          description: 'Contactos paginados',
          type: 'object',
          properties: {
            contacts: { type: 'array', items: ContactObject },
            total:    { type: 'integer' },
            page:     { type: 'integer' },
            limit:    { type: 'integer' },
          },
        },
        401: { description: 'No autenticado', ...errorResponse },
      },
    },
  }, async (request) => {
    const { page, limit, search } = request.query
    return contactService.listContacts(request.workspaceId, { page, limit, search })
  })

  // ─── GET /api/:workspaceId/contacts/:contactId ────────────────────────────
  fastify.get('/:contactId', {
    preHandler,
    schema: {
      tags: ['Contacts'],
      summary: 'Obtener contacto',
      description: 'Retorna el detalle completo de un contacto incluyendo historial.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'contactId'],
        properties: {
          workspaceId: { type: 'string' },
          contactId:   { type: 'string', description: 'ID del contacto' },
        },
      },
      response: {
        200: { description: 'Contacto encontrado', ...ContactObject },
        404: { description: 'Contacto no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    return contactService.getContact(request.workspaceId, request.params.contactId)
  })

  // ─── DELETE /api/:workspaceId/contacts/:contactId ────────────────────────
  fastify.delete('/:contactId', {
    preHandler,
    schema: {
      tags: ['Contacts'],
      summary: 'Eliminar contacto',
      description: 'Elimina el contacto y todas sus conversaciones y mensajes permanentemente.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'contactId'],
        properties: {
          workspaceId: { type: 'string' },
          contactId:   { type: 'string' },
        },
      },
      response: {
        200: { description: 'Contacto eliminado', type: 'object', properties: { ok: { type: 'boolean' } } },
        404: { description: 'Contacto no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    await contactService.deleteContact(request.workspaceId, request.params.contactId)
    return { ok: true }
  })

  // ─── PATCH /api/:workspaceId/contacts/:contactId/fields ───────────────────
  fastify.patch('/:contactId/fields', {
    preHandler,
    schema: {
      tags: ['Contacts'],
      summary: 'Actualizar campos personalizados',
      description: 'Reemplaza o agrega campos custom en `custom_fields`. Útil para guardar datos de CRM como `plan`, `empresa`, `id_externo`, etc.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'contactId'],
        properties: {
          workspaceId: { type: 'string' },
          contactId:   { type: 'string' },
        },
      },
      body: {
        type: 'object',
        description: 'Objeto libre con los campos a actualizar',
        example: { empresa: 'Acme Corp', plan: 'pro', id_crm: 'CRM-001' },
      },
      response: {
        200: { description: 'Contacto actualizado', ...ContactObject },
        404: { description: 'Contacto no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    return contactService.updateContactFields(request.workspaceId, request.params.contactId, request.body)
  })
}

module.exports = contactRoutes
