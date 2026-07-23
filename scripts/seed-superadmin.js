#!/usr/bin/env node
'use strict'

/**
 * Seed script: crea el SuperAdmin inicial y las PlanDefinitions por defecto.
 *
 * Uso:
 *   node scripts/seed-superadmin.js
 *
 * Variables de entorno requeridas (o usa los valores por defecto de desarrollo):
 *   SUPERADMIN_EMAIL     — email del superadmin inicial
 *   SUPERADMIN_PASSWORD  — contraseña del superadmin inicial
 *   SUPERADMIN_NAME      — nombre del superadmin inicial
 *   MONGODB_URI          — URI de MongoDB
 */

require('dotenv').config()

const mongoose = require('mongoose')
const bcrypt = require('bcrypt')

// Registrar modelos necesarios
const SuperAdmin    = require('../src/db/models/super-admin')
const PlanDefinition = require('../src/db/models/plan-definition')

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/NexoraChat'

// ─── Definiciones de planes por defecto ───────────────────────────────────────

const DEFAULT_PLAN_DEFINITIONS = [
  {
    tier: 'free',
    name: 'Free',
    description: 'Para empezar. Sin tarjeta de crédito.',
    price_monthly: 0,
    price_yearly: 0,
    limits: {
      conversations_per_month: 100,
      agents: 2,
      channels: 1,
      storage_gb: 1,
      knowledge_items: 50,
      bots: 0,
    },
    features: ['web_widget'],
    trial_days: 0,
    active: true,
    sort_order: 1,
  },
  {
    tier: 'starter',
    name: 'Starter',
    description: 'Para equipos pequeños que quieren crecer.',
    price_monthly: 2900,   // $29.00 USD
    price_yearly: 27840,   // $278.40 USD (20% descuento)
    limits: {
      conversations_per_month: 1000,
      agents: 5,
      channels: 3,
      storage_gb: 5,
      knowledge_items: 500,
      bots: 1,
    },
    features: ['web_widget', 'whatsapp', 'telegram', 'knowledge_base', 'analytics'],
    trial_days: 14,
    active: true,
    sort_order: 2,
  },
  {
    tier: 'pro',
    name: 'Pro',
    description: 'Para empresas que necesitan más potencia.',
    price_monthly: 7900,   // $79.00 USD
    price_yearly: 75840,   // $758.40 USD (20% descuento)
    limits: {
      conversations_per_month: 5000,
      agents: 20,
      channels: 10,
      storage_gb: 20,
      knowledge_items: 2000,
      bots: 5,
    },
    features: [
      'web_widget', 'whatsapp', 'telegram', 'api',
      'bot', 'analytics', 'sla', 'knowledge_base',
      'leads', 'api_access', 'custom_branding',
    ],
    trial_days: 14,
    active: true,
    sort_order: 3,
  },
  {
    tier: 'enterprise',
    name: 'Enterprise',
    description: 'Sin límites. Soporte dedicado.',
    price_monthly: 0,   // Precio negociado — 0 = contactar ventas
    price_yearly: 0,
    limits: {
      conversations_per_month: -1,  // -1 = ilimitado
      agents: -1,
      channels: -1,
      storage_gb: 100,
      knowledge_items: -1,
      bots: -1,
    },
    features: [
      'web_widget', 'whatsapp', 'telegram', 'api',
      'bot', 'analytics', 'sla', 'knowledge_base',
      'leads', 'api_access', 'custom_branding',
    ],
    trial_days: 30,
    active: true,
    sort_order: 4,
  },
]

// ─── Main ─────────────────────────────────────────────────────────────────────

async function seed() {
  await mongoose.connect(MONGODB_URI)
  console.log('Conectado a MongoDB')

  // 1. Crear o actualizar PlanDefinitions
  console.log('\n--- Plan Definitions ---')
  for (const def of DEFAULT_PLAN_DEFINITIONS) {
    const existing = await PlanDefinition.findOne({ tier: def.tier })
    if (existing) {
      await PlanDefinition.updateOne({ tier: def.tier }, { $set: def })
      console.log(`  [updated] ${def.tier} — ${def.name}`)
    } else {
      await PlanDefinition.create(def)
      console.log(`  [created] ${def.tier} — ${def.name}`)
    }
  }

  // 2. Crear SuperAdmin inicial
  console.log('\n--- Super Admin ---')
  const email    = process.env.SUPERADMIN_EMAIL    || 'admin@NexoraChat.com'
  const password = process.env.SUPERADMIN_PASSWORD || 'Admin1234!'
  const name     = process.env.SUPERADMIN_NAME     || 'Super Admin'

  const existing = await SuperAdmin.findOne({ email })
  if (existing) {
    console.log(`  [skip] SuperAdmin "${email}" ya existe`)
  } else {
    const password_hash = await bcrypt.hash(password, 12)
    await SuperAdmin.create({ email, password_hash, name, role: 'superadmin' })
    console.log(`  [created] SuperAdmin "${email}"`)
    console.log(`  [warning] Cambia la contraseña despues del primer login!`)
  }

  console.log('\nSeed completado exitosamente.')
  await mongoose.disconnect()
}

seed().catch(err => {
  console.error('Error en seed:', err)
  process.exit(1)
})
