'use strict'

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')
const path = require('path')
const fs   = require('fs')
const { v4: uuidv4 } = require('uuid')
const Attachment = require('../db/models/attachment')
const msgService = require('./message.service')

const BUCKET     = process.env.R2_BUCKET_NAME || 'NexoraChat-files'
const PUBLIC_URL = process.env.R2_PUBLIC_URL  || ''

// Detectar si R2 está configurado
const R2_CONFIGURED = !!(
  process.env.R2_ACCOUNT_ID &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY
)

// Cliente S3 solo se crea si R2 está configurado
const s3 = R2_CONFIGURED
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null

// Directorio local para uploads en desarrollo
const LOCAL_UPLOADS_DIR = path.join(__dirname, '../../uploads')
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:4000'

const MIME_TO_TYPE = {
  'image/': 'image',
  'audio/': 'audio',
  'video/': 'video',
  'application/': 'document',
  'text/': 'document',
}

function inferAttachmentType(mimetype) {
  for (const [prefix, type] of Object.entries(MIME_TO_TYPE)) {
    if (mimetype.startsWith(prefix)) return type
  }
  return 'document'
}

async function uploadFile({ workspaceId, buffer, filename, mimetype }) {
  const ext  = path.extname(filename) || ''
  const date = new Date().toISOString().slice(0, 10)
  const key  = `${workspaceId}/${date}/${uuidv4()}${ext}`

  if (R2_CONFIGURED) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    }))
    const url = PUBLIC_URL ? `${PUBLIC_URL}/${key}` : key
    return { key, url }
  }

  // Fallback: guardar en disco local
  const localPath = path.join(LOCAL_UPLOADS_DIR, key)
  fs.mkdirSync(path.dirname(localPath), { recursive: true })
  fs.writeFileSync(localPath, buffer)
  const url = `${BACKEND_URL}/uploads/${key}`
  return { key, url }
}

async function uploadMessageFile({ workspaceId, conversationId, senderId, file }) {
  const chunks = []
  for await (const chunk of file.file) {
    chunks.push(chunk)
  }
  const buffer = Buffer.concat(chunks)
  const { key, url } = await uploadFile({ workspaceId, buffer, filename: file.filename, mimetype: file.mimetype })

  const attachmentType = inferAttachmentType(file.mimetype)

  const { message } = await msgService.createMessage({
    workspaceId,
    conversationId,
    senderType: 'agent',
    senderId,
    type: attachmentType,
    content: file.filename,
  })

  const attachment = await Attachment.create({
    workspace_id: workspaceId,
    message_id:   message._id,
    type:         attachmentType,
    filename:     file.filename,
    mime_type:    file.mimetype,
    size_bytes:   buffer.length,
    url,
    s3_key:       key,
  })

  message.attachment_ids = [attachment._id]
  await message.save()

  return { message, attachment }
}

module.exports = { uploadFile, uploadMessageFile }
