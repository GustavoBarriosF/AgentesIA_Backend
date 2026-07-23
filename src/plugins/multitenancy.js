'use strict'

const fp = require('fastify-plugin')
const Plan = require('../db/models/plan')

async function multitenancyPlugin(fastify) {
  /**
   * Verifica que el usuario tiene acceso al workspace del request.
   * También bloquea si el workspace está suspendido.
   * Uso: preHandler: [fastify.authenticate, fastify.requireWorkspace]
   * Adjunta request.workspaceId y request.workspaceRole
   */
  fastify.decorate('requireWorkspace', async function(request, reply) {
    const workspaceId = request.params.workspaceId || request.headers['x-workspace-id']

    if (!workspaceId) {
      return reply.code(400).send({ error: 'workspace_id requerido' })
    }

    const workspaces = request.user?.workspaces || []
    const entry = workspaces.find(w => w.id === workspaceId)

    if (!entry) {
      return reply.code(403).send({ error: 'Acceso denegado a este workspace' })
    }

    // Bloquear acceso si el workspace está suspendido
    const plan = await Plan.findOne({ workspace_id: workspaceId })
      .select('status suspension_reason')
      .lean()

    if (plan?.status === 'suspended') {
      return reply.code(403).send({
        error: 'workspace_suspended',
        message: 'Este workspace ha sido suspendido. Contacta a soporte para más información.',
        reason: plan.suspension_reason || null,
      })
    }

    request.workspaceId = workspaceId
    request.workspaceRole = entry.role
  })

  /**
   * Verifica rol minimo requerido dentro del workspace.
   * Uso: fastify.requireRole('admin')
   */
  const ROLE_LEVELS = { viewer: 0, agent: 1, admin: 2, owner: 3 }

  fastify.decorate('requireRole', function(minRole) {
    return async function(request, reply) {
      const userLevel = ROLE_LEVELS[request.workspaceRole] ?? -1
      const requiredLevel = ROLE_LEVELS[minRole] ?? 99
      if (userLevel < requiredLevel) {
        return reply.code(403).send({ error: `Se requiere rol ${minRole} o superior` })
      }
    }
  })
}

module.exports = fp(multitenancyPlugin, { name: 'multitenancy' })
