# TrivoxChat — Backend

> Plataforma SaaS multi-tenant de comunicación multicanal con IA: atención al cliente, bots conversacionales, base de conocimiento con RAG, campañas de marketing, cobros y facturación electrónica.

Backend construido sobre **Fastify** que unifica múltiples canales de mensajería (WhatsApp, Telegram, web widget, email, redes sociales…) en un único inbox, con agentes de IA, enrutamiento a humanos, analítica, billing por suscripción y un panel de super administración.

---

## Tabla de contenidos

- [Características](#características)
- [Stack tecnológico](#stack-tecnológico)
- [Arquitectura](#arquitectura)
- [Requisitos previos](#requisitos-previos)
- [Instalación](#instalación)
- [Variables de entorno](#variables-de-entorno)
- [Ejecución](#ejecución)
- [Estructura del proyecto](#estructura-del-proyecto)
- [API y documentación](#api-y-documentación)
- [Jobs en background](#jobs-en-background)
- [Despliegue](#despliegue)

---

## Características

### 💬 Mensajería omnicanal
Un solo backend gestiona conversaciones a través de múltiples canales, cada uno configurable por workspace:

- **Web Widget** embebible y personalizable (colores, avatar, posición, ícono, tipografía…)
- **WhatsApp** vía Meta Cloud API (WhatsApp Business)
- **WhatsApp** vía [Baileys](https://github.com/WhiskeySockets/Baileys) (conexión con QR, sin API oficial)
- **Telegram**
- **Facebook Messenger** e **Instagram DM**
- **Email** (canal de soporte con SMTP de envío + webhooks de entrada: SendGrid, Mailgun, Postmark…)
- **Slack** y **Microsoft Teams**
- **SMS**, **LINE** y **API** genérica

### 🤖 Bots y agentes de IA
Dos tipos de bot unificados en el modelo `BotAgent`:

- **Decision Bot** — árbol de decisiones con opciones/botones, pasos y enrutamiento.
- **AI Agent** — agente LLM con *system prompt*, base de conocimiento propia (RAG) y protocolos estructurados opcionales.

Acciones disponibles en los flujos: recolección de datos (nombre, email, teléfono, identificación), escalado a humano, creación de tickets con resumen por IA, envío de links de pago y **operaciones ERP** (consultar saldo, listar facturas, crear factura, registrar pago).

**Proveedores LLM soportados** (seleccionables por workspace o por bot):

| Proveedor | Modelo por defecto |
|-----------|--------------------|
| Anthropic Claude | `claude-haiku-4-5` |
| OpenAI | `gpt-4o-mini` |
| Google Gemini | `gemini-2.0-flash` |
| Groq | `llama-3.3-70b-versatile` |
| Ollama (local) | `llama3.2:latest` |

### 📚 Base de conocimiento con RAG
Retrieval-Augmented Generation completo: los documentos se dividen en *chunks*, se generan *embeddings* con **Ollama** y se almacenan en **Qdrant** (base de datos vectorial). Búsqueda semántica con *fallback* a similitud coseno en MongoDB y a búsqueda por palabras clave. Ingesta de PDF, DOCX y XLSX.

### 🎯 Enrutamiento y atención humana
- El bot atiende primero; escala a la cola de agentes según reglas (bot deshabilitado, límite de turnos, baja confianza, horario de atención).
- Asignación automática de conversaciones, departamentos y roles (`viewer`, `agent`, `admin`, `owner`).
- Tickets con **SLA** por plan y encuestas de satisfacción (**CSAT**).
- Gestión de **contactos** y **leads**.

### 📣 Campañas de marketing
Campañas multicanal (`immediate`, `drip`, `trigger` por inactividad/cumpleaños) con segmentación de audiencia, procesamiento por lotes con *rate limiting*, seguimiento de entregas/lecturas y gestión de *opt-out*.

### 💳 Cobros y facturación
- **Links de pago** generados con múltiples pasarelas: **Stripe, MercadoPago, PayPal, Wompi, ePayco, PayU**.
- Integraciones **ERP** para facturación electrónica: **Siigo, Alegra, QuickBooks** (autenticación de clientes, estados de cuenta, facturas, pagos).

### 🏢 Multi-tenancy y billing
- Aislamiento por **workspace** (`/api/:workspaceId/...`) con *branding*, ajustes de negocio e integraciones propias.
- Planes de suscripción (`free`, `starter`, `pro`, `enterprise`) con límites por recurso (conversaciones/mes, agentes, canales, almacenamiento, ítems de conocimiento, bots) y *feature flags*.
- Facturación con **Stripe**, cupones e invoices.
- **Panel de Super Admin** independiente: dashboard, gestión de workspaces, definiciones de planes, cupones y facturación.

### 📊 Otras capacidades
- **Analítica** de conversaciones, canales, SLA y desempeño de bots/agentes (con caché en Redis).
- **Almacenamiento** de archivos en **Cloudflare R2** (S3) con *fallback* a disco local.
- **Tiempo real** vía WebSockets (Socket.io + `@fastify/websocket`).
- Autenticación **JWT** con verificación de email, *rate limiting* y cabeceras de seguridad (Helmet).
- Documentación **OpenAPI/Swagger** autogenerada.

---

## Stack tecnológico

- **Runtime:** Node.js ≥ 20
- **Framework:** Fastify 4
- **Base de datos:** MongoDB (Mongoose)
- **Caché / colas:** Redis (ioredis)
- **Vector DB:** Qdrant
- **Embeddings / LLM local:** Ollama
- **Tiempo real:** Socket.io + `@fastify/websocket`
- **Auth:** `@fastify/jwt`, bcrypt
- **Docs:** `@fastify/swagger` + Swagger UI
- **Jobs:** node-cron
- **Almacenamiento:** AWS SDK S3 (compatible con Cloudflare R2)
- **WhatsApp no oficial:** `@whiskeysockets/baileys` (+ `qrcode`)
- **Parsing de archivos:** `pdf-parse`, `mammoth`, `xlsx`
- **Pagos:** Stripe SDK + pasarelas vía `axios`
- **Email:** Nodemailer (Resend / SendGrid)
- **Validación:** Zod / JSON Schema (AJV)
- **Logging:** Pino

---

## Arquitectura

```
                        ┌─────────────────────────────────┐
   Canales entrantes    │            Fastify API          │
  (WhatsApp, Telegram,  │                                 │
   Widget, Email, …) ──▶│  Webhooks  ─┐                   │
                        │  Widget     ─┤                   │
                        │  Auth       ─┤   Plugins:        │
   Panel Admin ────────▶│  /api/:wsId ─┤   · auth (JWT)    │
                        │  /superadmin─┘   · multitenancy  │
                        │                  · plan-enforce   │
                        │                  · ratelimit      │
                        │                  · websocket      │
                        └───────┬───────────┬───────────┬──┘
                                │           │           │
                    ┌───────────▼──┐  ┌─────▼─────┐  ┌──▼─────────┐
                    │   MongoDB    │  │   Redis   │  │  Qdrant    │
                    │  (Mongoose)  │  │(cache/cola)│  │ (vectores) │
                    └──────────────┘  └───────────┘  └────────────┘
                                │
              ┌─────────────────┼──────────────────────────┐
         LLMs (Claude/OpenAI/  Ollama (embeddings)   ERP / Pasarelas /
         Gemini/Groq/Ollama)                          R2 / Email
```

El flujo de un mensaje entrante:

1. Llega por **webhook** (o widget/WhatsApp Baileys) → `incoming-message.service`.
2. Se resuelve/crea **contacto** y **conversación**.
3. `routing.service` decide: **bot** o **cola de agentes**.
4. Si es bot, `bot.service` ejecuta el flujo (decision tree o AI agent con RAG).
5. La respuesta se envía por el canal de origen y se emite por **WebSocket** al panel.

---

## Requisitos previos

- **Node.js** ≥ 20
- **MongoDB**
- **Redis**
- **Qdrant** (para RAG) — opcional si no se usa base de conocimiento vectorial
- **Ollama** (para embeddings/LLM local) — opcional
- Claves de API según los servicios que se activen (Anthropic, OpenAI, Stripe, etc.)

---

## Instalación

```bash
git clone <repo-url>
cd backend
npm install
cp .env.example .env   # y completa los valores
```

Crea el Super Admin inicial y las definiciones de planes por defecto:

```bash
npm run seed:superadmin
```

---

## Variables de entorno

Copia `.env.example` a `.env`. Las principales:

| Variable | Descripción |
|----------|-------------|
| `PORT` / `HOST` | Puerto y host del servidor (default `3000` / `0.0.0.0`) |
| `MONGODB_URI` | Conexión a MongoDB |
| `REDIS_URL` | Conexión a Redis |
| `JWT_SECRET` / `JWT_EXPIRES_IN` | Firma y expiración de tokens de usuario |
| `ANTHROPIC_API_KEY` | Clave global de Claude (fallback) |
| `OLLAMA_URL` / `OLLAMA_EMBED_MODEL` | Servidor Ollama y modelo de embeddings para RAG |
| `QDRANT_URL` / `QDRANT_API_KEY` | Base de datos vectorial |
| `META_GRAPH_API_VERSION` | Versión de la Graph API de Meta |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` | Almacenamiento en Cloudflare R2 (si no se configuran, se usa disco local en `/uploads`) |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `FROM_EMAIL` | Envío de email (Resend / SendGrid) |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET` | Billing con Stripe |
| `SUPERADMIN_JWT_SECRET`, `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`, `SUPERADMIN_NAME` | Panel de Super Admin y seed inicial |
| `FRONTEND_URL`, `PUBLIC_APP_URL`, `PUBLIC_API_URL`, `ADMIN_URL` | URLs públicas |
| `NODE_ENV` / `SKIP_EMAIL_VERIFICATION` | Entorno; en `development` (o sin proveedor de email) se omite la verificación de email |

> **Nota multi-tenant:** credenciales de canales por cliente (WhatsApp/Meta, Slack, Teams, Instagram, ERP, pasarelas de pago, etc.) **no** se configuran como variables globales, sino en la configuración de cada canal/integración del workspace (`channel.config`).

---

## Ejecución

```bash
# Desarrollo (con recarga automática)
npm run dev

# Producción
npm start
```

El servidor arranca en `http://localhost:3000` (o el `PORT` configurado). Endpoint de salud: `GET /health`.

---

## Estructura del proyecto

```
backend/
├── src/
│   ├── app.js                 # Bootstrap: plugins, rutas, jobs, shutdown
│   ├── db/
│   │   ├── connect.js         # Conexión a MongoDB
│   │   ├── redis.js           # Conexión a Redis
│   │   └── models/            # Modelos Mongoose (workspace, user, channel,
│   │                          #   conversation, message, bot-agent, plan, …)
│   ├── plugins/               # auth, multitenancy, plan-enforcement,
│   │                          #   ratelimit, websocket, swagger, superadmin-auth
│   ├── routes/                # Endpoints agrupados por recurso
│   │   ├── auth/  channels/  agents/  conversations/  messages/
│   │   ├── knowledge/  tickets/  leads/  analytics/  bots/  campaigns/
│   │   ├── products/  payment-gateways/  payment-links/  erp-integrations/
│   │   ├── webhooks/  widget/  baileys.js
│   │   └── superadmin/        # dashboard, workspaces, plan-definitions, coupons, billing
│   ├── services/              # Lógica de negocio
│   │   ├── llm/               # Adaptadores: claude, openai, gemini, groq, ollama
│   │   ├── gateways/          # Pasarelas: stripe, mercadopago, paypal, wompi, epayco, payu
│   │   ├── erp/               # Adaptadores ERP: siigo, alegra, quickbooks
│   │   ├── rag.service.js  knowledge.service.js  bot.service.js
│   │   ├── routing.service.js  campaign.service.js  storage.service.js  …
│   ├── jobs/                  # Tareas cron
│   ├── middleware/            # roles.js
│   ├── schemas/               # Schemas comunes
│   └── utils/                 # logger, helpers
├── scripts/
│   └── seed-superadmin.js     # Seed de Super Admin + planes
├── uploads/                   # Almacenamiento local (fallback de R2)
├── Dockerfile
├── ecosystem.config.js        # Configuración PM2
└── .env.example
```

### Grupos de rutas

| Prefijo | Descripción |
|---------|-------------|
| `/auth` | Registro, login, verificación de email |
| `/superadmin/*` | Panel de administración global (auth propia) |
| `/webhooks/*` | Recepción de eventos de canales y pagos (verificación propia, sin JWT) |
| `/widget/*` | API pública del widget web |
| `/api/:workspaceId/*` | API principal por workspace (channels, agents, conversations, messages, knowledge, tickets, leads, analytics, bots, plans, ai-providers, products, payment-gateways, payment-links, campaigns, ERP) |
| `/health` | Health check |

---

## API y documentación

Con el servidor en marcha, la documentación interactiva **Swagger UI** queda disponible (generada por `@fastify/swagger` + `@fastify/swagger-ui`). Revisa el registro del plugin en [`src/plugins/swagger.js`](src/plugins/swagger.js) para la ruta exacta de la UI.

La API principal requiere:
- Token **JWT** (`Authorization: Bearer <token>`) obtenido en `/auth/login`.
- El **`workspaceId`** en la ruta; el plugin de multitenancy valida la pertenencia del usuario al workspace.

---

## Jobs en background

Se inician automáticamente al arrancar (salvo `NODE_ENV=test`), usando `node-cron`:

| Job | Función |
|-----|---------|
| `sla-monitor` | Detecta incumplimientos de SLA en tickets según el plan (Free 48h · Starter 24h · Pro 8h · Enterprise 4h) |
| `abandoned-conversations` | Marca como abandonadas las conversaciones inactivas (> 4h) |
| `usage-reset` | Reinicia contadores mensuales de uso de los planes |
| `queue-processor` | Procesa las colas de asignación de agentes (Redis) |
| `campaign-processor` | Ejecuta campañas programadas, drip y triggers (cada minuto) |

Además, al iniciar se restauran las sesiones activas de **WhatsApp Baileys**.

---

## Despliegue

### Docker

```bash
docker build -t trivoxchat-backend .
docker run -p 3000:3000 --env-file .env trivoxchat-backend
```

### PM2

El repo incluye [`ecosystem.config.js`](ecosystem.config.js) para gestionar el proceso con PM2:

```bash
pm2 start ecosystem.config.js
```

El servidor maneja *graceful shutdown* ante `SIGTERM`/`SIGINT` (cierra Fastify y Redis).

---

## Scripts npm

| Script | Acción |
|--------|--------|
| `npm start` | Inicia el servidor |
| `npm run dev` | Inicia con recarga automática (nodemon) |
| `npm test` | Ejecuta la suite de tests (`node --test`) |
| `npm run seed:superadmin` | Crea el Super Admin y las definiciones de planes por defecto |
