'use strict'

const { getRedis }   = require('../db/redis')
const Workspace      = require('../db/models/workspace')
const WorkspaceMember= require('../db/models/workspace-member')
const Department     = require('../db/models/department')
const User           = require('../db/models/user')
const Plan           = require('../db/models/plan')
const Agent          = require('../db/models/agent')
const bcrypt         = require('bcrypt')

async function getWorkspace(workspaceId) {
  const ws = await Workspace.findById(workspaceId).lean()
  if (!ws) throw Object.assign(new Error('Workspace no encontrado'), { statusCode: 404 })
  return {
    ...ws,
    integrations: {
      anthropic_api_configured: !!(ws.integrations?.anthropic_api_key),
    },
  }
}

const BOT_MESSAGES_FIELDS = [
  'transfer_to_agent', 'max_turns_reached',
  'collect_name_error', 'collect_email_error', 'collect_phone_error', 'collect_id_error',
  'erp_customer_not_found', 'ticket_created', 'out_of_hours', 'no_agents_available',
]

async function updateWorkspace(workspaceId, data) {
  const $set = {}

  if (data.name       !== undefined) $set.name        = data.name
  if (data.branding   !== undefined) $set.branding     = data.branding
  if (data.integrations !== undefined) $set.integrations = data.integrations

  // Merge settings campo por campo para no sobrescribir campos no enviados
  if (data.settings !== undefined) {
    const { bot_messages, ...restSettings } = data.settings

    // Campos de settings que no son bot_messages los seteamos en bloque
    if (Object.keys(restSettings).length > 0) {
      for (const [k, v] of Object.entries(restSettings)) {
        $set[`settings.${k}`] = v
      }
    }

    // bot_messages: merge campo por campo con dot-notation
    if (bot_messages !== undefined) {
      for (const field of BOT_MESSAGES_FIELDS) {
        if (bot_messages[field] !== undefined) {
          $set[`settings.bot_messages.${field}`] = bot_messages[field]
        }
      }
    }
  }

  const workspace = await Workspace.findByIdAndUpdate(workspaceId, { $set }, { new: true, runValidators: true })
  if (!workspace) throw Object.assign(new Error('Workspace no encontrado'), { statusCode: 404 })

  // Invalidar caché de bot_messages para que el próximo mensaje cargue la config actualizada
  if (data.settings?.bot_messages !== undefined) {
    try {
      const redis = getRedis()
      await redis.del(`ws:bot_messages:${workspaceId}`)
    } catch (_) {
      // no-op: la caché expirará automáticamente
    }
  }

  return workspace
}

// ─── Members ──────────────────────────────────────────────────────────────────

async function listMembers(workspaceId) {
  const members = await WorkspaceMember.find({ workspace_id: workspaceId })
    .populate('user_id', 'name email avatar_url')
    .populate('department_id', 'name color')
    .lean()

  return members.map(m => ({
    _id:           m._id,
    user:          m.user_id,
    role:          m.role,
    active:        m.active,
    last_active_at:m.last_active_at,
    joined_at:     m.createdAt,
    department:    m.department_id ?? null,
  }))
}

function requireDeptForRole(role, department_id) {
  if (['agent', 'viewer'].includes(role) && !department_id) {
    throw Object.assign(new Error('Los agentes y visores deben tener un departamento asignado'), { statusCode: 400 })
  }
}

async function inviteMember(workspaceId, { email, role, department_id }) {
  requireDeptForRole(role, department_id)
  let user = await User.findOne({ email })

  if (!user) {
    const crypto = require('crypto')
    const verification_token = crypto.randomBytes(32).toString('hex')
    user = await User.create({ name: email.split('@')[0], email, provider: 'local', verification_token })
  }

  const existing = await WorkspaceMember.findOne({ workspace_id: workspaceId, user_id: user._id })
  if (existing) {
    if (!existing.active) {
      existing.active = true
      existing.role   = role
      if (department_id !== undefined) existing.department_id = department_id || null
      await existing.save()
      return existing
    }
    throw Object.assign(new Error('El usuario ya es miembro de este workspace'), { statusCode: 409 })
  }

  const member = await WorkspaceMember.create({
    workspace_id:  workspaceId,
    user_id:       user._id,
    role,
    department_id: department_id || null,
  })

  if (['agent', 'admin', 'owner'].includes(role)) {
    await Agent.findOneAndUpdate(
      { workspace_id: workspaceId, user_id: user._id },
      { $setOnInsert: { workspace_id: workspaceId, user_id: user._id } },
      { upsert: true }
    )
  }

  return member
}

async function createMember(workspaceId, { name, email, password, role, department_id }) {
  requireDeptForRole(role, department_id)
  const existing = await User.findOne({ email })
  if (existing) {
    // Si ya existe, intentar agregarlo al workspace
    const alreadyMember = await WorkspaceMember.findOne({ workspace_id: workspaceId, user_id: existing._id })
    if (alreadyMember && alreadyMember.active) {
      throw Object.assign(new Error('Ya existe un usuario con ese email en este workspace'), { statusCode: 409 })
    }
    if (alreadyMember && !alreadyMember.active) {
      alreadyMember.active        = true
      alreadyMember.role          = role
      alreadyMember.department_id = department_id || null
      await alreadyMember.save()
      return alreadyMember
    }
    const member = await WorkspaceMember.create({
      workspace_id:  workspaceId,
      user_id:       existing._id,
      role,
      department_id: department_id || null,
    })
    if (['agent', 'admin', 'owner'].includes(role)) {
      await Agent.findOneAndUpdate(
        { workspace_id: workspaceId, user_id: existing._id },
        { $setOnInsert: { workspace_id: workspaceId, user_id: existing._id } },
        { upsert: true }
      )
    }
    return member
  }

  // Crear usuario nuevo con contraseña
  const password_hash = await bcrypt.hash(password, 10)
  const user = await User.create({ name, email, password_hash, provider: 'local', verified: true })

  const member = await WorkspaceMember.create({
    workspace_id:  workspaceId,
    user_id:       user._id,
    role,
    department_id: department_id || null,
  })

  if (['agent', 'admin', 'owner'].includes(role)) {
    await Agent.findOneAndUpdate(
      { workspace_id: workspaceId, user_id: user._id },
      { $setOnInsert: { workspace_id: workspaceId, user_id: user._id } },
      { upsert: true }
    )
  }

  return member
}

async function updateMember(workspaceId, memberId, { role, active, department_id }) {
  const member = await WorkspaceMember.findOne({ _id: memberId, workspace_id: workspaceId })
  if (!member) throw Object.assign(new Error('Miembro no encontrado'), { statusCode: 404 })

  if (member.role === 'owner' && active === false) {
    const ownerCount = await WorkspaceMember.countDocuments({ workspace_id: workspaceId, role: 'owner', active: true })
    if (ownerCount <= 1) throw Object.assign(new Error('No se puede desactivar al unico owner'), { statusCode: 400 })
  }

  const finalRole = role !== undefined ? role : member.role
  const finalDept = department_id !== undefined ? (department_id || null) : member.department_id
  requireDeptForRole(finalRole, finalDept)

  if (role            !== undefined) member.role          = role
  if (active          !== undefined) member.active        = active
  if (department_id   !== undefined) member.department_id = department_id || null
  await member.save()
  return member
}

// ─── Departments ──────────────────────────────────────────────────────────────

async function listDepartments(workspaceId) {
  const [departments, memberCounts] = await Promise.all([
    Department.find({ workspace_id: workspaceId }).sort({ name: 1 }).lean(),
    WorkspaceMember.aggregate([
      { $match: { workspace_id: new (require('mongoose').Types.ObjectId)(workspaceId.toString()), active: true, department_id: { $ne: null } } },
      { $group: { _id: '$department_id', count: { $sum: 1 } } },
    ]),
  ])

  const countMap = Object.fromEntries(memberCounts.map(m => [m._id.toString(), m.count]))
  return departments.map(d => ({ ...d, members_count: countMap[d._id.toString()] ?? 0 }))
}

async function createDepartment(workspaceId, { name, description, color }) {
  const dept = await Department.create({ workspace_id: workspaceId, name, description: description ?? '', color: color ?? '#6366f1' })
  return { ...dept.toObject(), members_count: 0 }
}

async function updateDepartment(workspaceId, deptId, { name, description, color }) {
  const dept = await Department.findOneAndUpdate(
    { _id: deptId, workspace_id: workspaceId },
    { $set: { ...(name !== undefined && { name }), ...(description !== undefined && { description }), ...(color !== undefined && { color }) } },
    { new: true, runValidators: true }
  ).lean()
  if (!dept) throw Object.assign(new Error('Departamento no encontrado'), { statusCode: 404 })
  return dept
}

async function deleteDepartment(workspaceId, deptId) {
  const dept = await Department.findOneAndDelete({ _id: deptId, workspace_id: workspaceId })
  if (!dept) throw Object.assign(new Error('Departamento no encontrado'), { statusCode: 404 })
  // Desasignar miembros del departamento eliminado
  await WorkspaceMember.updateMany(
    { workspace_id: workspaceId, department_id: deptId },
    { $set: { department_id: null } }
  )
  return { ok: true }
}

module.exports = {
  getWorkspace, updateWorkspace,
  listMembers, inviteMember, createMember, updateMember,
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
}
