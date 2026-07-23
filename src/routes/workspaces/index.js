'use strict'

const workspaceService = require('../../services/workspace.service')
const { workspaceParam, errorResponse, security } = require('../../schemas/common')

const MemberObject = {
  type: 'object',
  additionalProperties: true,
  properties: {
    _id:           { type: 'string' },
    user:          { type: 'object', additionalProperties: true },
    role:          { type: 'string', enum: ['owner', 'admin', 'agent', 'viewer'] },
    active:        { type: 'boolean' },
    last_active_at:{ type: 'string', format: 'date-time', nullable: true },
    department:    { type: 'object', nullable: true, additionalProperties: true },
  },
}

const DepartmentObject = {
  type: 'object',
  additionalProperties: true,
  properties: {
    _id:          { type: 'string' },
    workspace_id: { type: 'string' },
    name:         { type: 'string' },
    description:  { type: 'string' },
    color:        { type: 'string' },
    members_count:{ type: 'integer' },
    createdAt:    { type: 'string', format: 'date-time' },
    updatedAt:    { type: 'string', format: 'date-time' },
  },
}

async function workspaceRoutes(fastify) {
  const preHandler   = [fastify.authenticate, fastify.requireWorkspace]
  const adminHandler = [...preHandler, fastify.requireRole('admin')]

  // ─── GET /api/:workspaceId ─────────────────────────────────────────────────
  fastify.get('/', {
    preHandler,
    schema: {
      tags: ['Workspaces'],
      summary: 'Obtener workspace',
      security,
      params: workspaceParam,
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (request) => {
    return workspaceService.getWorkspace(request.workspaceId)
  })

  // ─── PATCH /api/:workspaceId ───────────────────────────────────────────────
  fastify.patch('/', {
    preHandler: adminHandler,
    schema: {
      tags: ['Workspaces'],
      summary: 'Actualizar workspace',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 2 },
          branding: { type: 'object', additionalProperties: true },
          settings: {
            type: 'object',
            additionalProperties: true,
            properties: {
              bot_messages: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  transfer_to_agent:       { type: ['string', 'null'] },
                  max_turns_reached:       { type: ['string', 'null'] },
                  collect_name_error:      { type: ['string', 'null'] },
                  collect_email_error:     { type: ['string', 'null'] },
                  collect_phone_error:     { type: ['string', 'null'] },
                  collect_id_error:        { type: ['string', 'null'] },
                  erp_customer_not_found:  { type: ['string', 'null'] },
                  ticket_created:          { type: ['string', 'null'] },
                  out_of_hours:            { type: ['string', 'null'] },
                  no_agents_available:     { type: ['string', 'null'] },
                },
              },
            },
          },
          integrations: { type: 'object', additionalProperties: true },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (request) => {
    return workspaceService.updateWorkspace(request.workspaceId, request.body)
  })

  // ─── GET /api/:workspaceId/members ────────────────────────────────────────
  fastify.get('/members', {
    preHandler,
    schema: {
      tags: ['Workspaces'],
      summary: 'Listar miembros del equipo',
      security,
      params: workspaceParam,
      response: {
        200: { type: 'array', items: MemberObject },
      },
    },
  }, async (request) => {
    return workspaceService.listMembers(request.workspaceId)
  })

  // ─── POST /api/:workspaceId/members ───────────────────────────────────────
  // Creación directa de miembro (con nombre, email y contraseña)
  fastify.post('/members', {
    preHandler: adminHandler,
    schema: {
      tags: ['Workspaces'],
      summary: 'Crear miembro directamente',
      description: 'Crea un nuevo usuario con contraseña y lo agrega al workspace. **Requiere rol admin.**',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['name', 'email', 'password', 'role'],
        properties: {
          name:          { type: 'string', minLength: 2 },
          email:         { type: 'string', format: 'email' },
          password:      { type: 'string', minLength: 6 },
          role:          { type: 'string', enum: ['admin', 'agent', 'viewer'] },
          department_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      response: {
        201: MemberObject,
        409: { description: 'El usuario ya existe en el workspace', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    await fastify.checkLimit(request.workspaceId, 'agent')
    const member = await workspaceService.createMember(request.workspaceId, request.body)
    return reply.code(201).send(member)
  })

  // ─── POST /api/:workspaceId/members/invite ────────────────────────────────
  fastify.post('/members/invite', {
    preHandler: adminHandler,
    schema: {
      tags: ['Workspaces'],
      summary: 'Invitar miembro por email',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['email', 'role'],
        properties: {
          email:         { type: 'string', format: 'email' },
          role:          { type: 'string', enum: ['admin', 'agent', 'viewer'] },
          department_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      response: {
        201: MemberObject,
        409: { description: 'El usuario ya es miembro', ...errorResponse },
      },
    },
  }, async (request, reply) => {
    await fastify.checkLimit(request.workspaceId, 'agent')
    const member = await workspaceService.inviteMember(request.workspaceId, request.body)
    return reply.code(201).send(member)
  })

  // ─── PATCH /api/:workspaceId/members/:memberId ────────────────────────────
  fastify.patch('/members/:memberId', {
    preHandler: adminHandler,
    schema: {
      tags: ['Workspaces'],
      summary: 'Actualizar miembro',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'memberId'],
        properties: {
          workspaceId: { type: 'string' },
          memberId:    { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          role:          { type: 'string', enum: ['admin', 'agent', 'viewer'] },
          active:        { type: 'boolean' },
          department_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
      },
      response: {
        200: MemberObject,
        404: { description: 'Miembro no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    return workspaceService.updateMember(request.workspaceId, request.params.memberId, request.body)
  })

  // ─── GET /api/:workspaceId/departments ────────────────────────────────────
  fastify.get('/departments', {
    preHandler,
    schema: {
      tags: ['Workspaces'],
      summary: 'Listar departamentos',
      security,
      params: workspaceParam,
      response: { 200: { type: 'array', items: DepartmentObject } },
    },
  }, async (request) => {
    return workspaceService.listDepartments(request.workspaceId)
  })

  // ─── POST /api/:workspaceId/departments ───────────────────────────────────
  fastify.post('/departments', {
    preHandler: adminHandler,
    schema: {
      tags: ['Workspaces'],
      summary: 'Crear departamento',
      security,
      params: workspaceParam,
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name:        { type: 'string', minLength: 2 },
          description: { type: 'string' },
          color:       { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
        },
      },
      response: { 201: DepartmentObject },
    },
  }, async (request, reply) => {
    const dept = await workspaceService.createDepartment(request.workspaceId, request.body)
    return reply.code(201).send(dept)
  })

  // ─── PATCH /api/:workspaceId/departments/:deptId ──────────────────────────
  fastify.patch('/departments/:deptId', {
    preHandler: adminHandler,
    schema: {
      tags: ['Workspaces'],
      summary: 'Actualizar departamento',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'deptId'],
        properties: {
          workspaceId: { type: 'string' },
          deptId:      { type: 'string' },
        },
      },
      body: {
        type: 'object',
        properties: {
          name:        { type: 'string', minLength: 2 },
          description: { type: 'string' },
          color:       { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
        },
      },
      response: {
        200: DepartmentObject,
        404: { description: 'Departamento no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    return workspaceService.updateDepartment(request.workspaceId, request.params.deptId, request.body)
  })

  // ─── DELETE /api/:workspaceId/departments/:deptId ─────────────────────────
  fastify.delete('/departments/:deptId', {
    preHandler: adminHandler,
    schema: {
      tags: ['Workspaces'],
      summary: 'Eliminar departamento',
      description: 'Elimina el departamento y desasigna los miembros que lo tenían.',
      security,
      params: {
        type: 'object',
        required: ['workspaceId', 'deptId'],
        properties: {
          workspaceId: { type: 'string' },
          deptId:      { type: 'string' },
        },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        404: { description: 'Departamento no encontrado', ...errorResponse },
      },
    },
  }, async (request) => {
    return workspaceService.deleteDepartment(request.workspaceId, request.params.deptId)
  })
}

module.exports = workspaceRoutes
