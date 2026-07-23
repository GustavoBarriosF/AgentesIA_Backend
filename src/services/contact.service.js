'use strict'

const Contact = require('../db/models/contact')
const Conversation = require('../db/models/conversation')
const Message = require('../db/models/message')
const { generateUniqueCode } = require('../utils/helpers')

async function findOrCreateContact(workspaceId, { channelRef, channelType, name, phone, email }) {
  let contact = await Contact.findOne({
    workspace_id: workspaceId,
    channel_ref: channelRef,
    channel_type: channelType,
  })

  if (!contact) {
    const customer_code = await generateUniqueCode(Contact, 'customer_code', { workspace_id: workspaceId }, 10000000, 99999999)
    contact = await Contact.create({
      workspace_id: workspaceId,
      channel_ref: channelRef,
      channel_type: channelType,
      name: name || 'Visitante',
      phone: phone || null,
      email: email || null,
      customer_code,
    })
  } else {
    contact.last_seen = new Date()
    if (name && contact.name === 'Visitante') contact.name = name
    await contact.save()
  }

  return contact
}

async function listContacts(workspaceId, { page = 1, limit = 20, search } = {}) {
  const query = { workspace_id: workspaceId }
  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
    ]
  }
  const skip = (page - 1) * limit
  const [contacts, total] = await Promise.all([
    Contact.find(query).sort({ last_seen: -1 }).skip(skip).limit(limit).lean(),
    Contact.countDocuments(query),
  ])
  return { contacts, total, page, limit }
}

async function getContact(workspaceId, contactId) {
  const contact = await Contact.findOne({ _id: contactId, workspace_id: workspaceId }).lean()
  if (!contact) throw Object.assign(new Error('Contacto no encontrado'), { statusCode: 404 })
  return contact
}

async function updateContactFields(workspaceId, contactId, custom_fields) {
  const contact = await Contact.findOneAndUpdate(
    { _id: contactId, workspace_id: workspaceId },
    { $set: { custom_fields } },
    { new: true }
  )
  if (!contact) throw Object.assign(new Error('Contacto no encontrado'), { statusCode: 404 })
  return contact
}

async function deleteContact(workspaceId, contactId) {
  const contact = await Contact.findOne({ _id: contactId, workspace_id: workspaceId })
  if (!contact) throw Object.assign(new Error('Contacto no encontrado'), { statusCode: 404 })

  // Eliminar mensajes y conversaciones del contacto
  const conversations = await Conversation.find({ contact_id: contactId }).select('_id').lean()
  const convIds = conversations.map(c => c._id)
  if (convIds.length > 0) {
    await Message.deleteMany({ conversation_id: { $in: convIds } })
    await Conversation.deleteMany({ _id: { $in: convIds } })
  }

  await Contact.findByIdAndDelete(contactId)
}

module.exports = { findOrCreateContact, listContacts, getContact, updateContactFields, deleteContact }
