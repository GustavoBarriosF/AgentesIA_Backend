'use strict'

/**
 * Middleware de verificacion de acceso a recursos especificos.
 * Se usa como preHandler adicional en rutas que requieren verificar
 * que el recurso pertenece al workspace del usuario.
 */

const ROLE_LEVELS = { viewer: 0, agent: 1, admin: 2, owner: 3 }

/**
 * Verifica que el usuario solo puede modificar su propio agente
 * a menos que sea admin/owner
 */
function ownAgentOrAdmin(request, reply, done) {
  const { agentId } = request.params
  const role = request.workspaceRole

  // Admins y owners pueden modificar cualquier agente
  if (ROLE_LEVELS[role] >= ROLE_LEVELS['admin']) return done()

  // Agentes solo pueden modificar su propio perfil
  // Necesitamos el agentId del usuario actual (se resuelve en el servicio)
  request.ownAgentOnly = true
  done()
}

module.exports = { ownAgentOrAdmin }
