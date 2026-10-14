# 🦷 Agenda Sonrisa — Fase 1 (+ blindaje de reservas y pagos Wompi)

Sistema para consultorios odontológicos: **agenda con reservas en línea, recordatorios por WhatsApp, pacientes, caja (abonos y anticipos), cartera, permisos granulares y modo vitrina** para vender con demos personalizadas.

Diseñado para funcionar **a costo cero** en el plan gratuito de Cloudflare, y portable a tu propio servidor (EC2) sin reescribir código.

---

## ✨ Funcionalidades

| Módulo | Qué hace |
|---|---|
| 📅 **Agenda** | Vista diaria por profesional, horarios con pausas, bloqueos (vacaciones), festivos de Colombia automáticos, citas recurrentes, **cero dobles reservas** (garantizado en la base de datos). |
| 🌐 **Reserva en línea** | Página pública por consultorio: servicio → profesional → día y hora → datos. Autorización Ley 1581, protección anti-bots, archivo de calendario (.ics). |
| 🔗 **Enlace del paciente** | Confirmar, reprogramar o cancelar sin cuenta, con enlace firmado criptográficamente. |
| 🔔 **Recordatorios** | WhatsApp con mensaje y enlace listos (sin API paga). Al confirmar, la cita cambia sola. Reactivación de pacientes inactivos y lista de espera. |
| 👥 **Pacientes** | Datos administrativos (nada clínico), historial de citas, estado de cuenta, exportación a Excel. |
| 💵 **Caja** | Recaudos con recibo consecutivo imprimible, abonos automáticos a lo más antiguo, anticipos (saldo a favor), cierre diario por medio de pago, anulaciones con motivo. |
| 📊 **Cartera** | Edades 0–30 / 31–60 / 61–90 / +90 días, botón de cobro amable por WhatsApp, Excel. |
| 🧾 **Facturación electrónica** | Factura de venta a partir de los cargos del paciente, sin facturar dos veces el mismo cargo. Tres modos: **registro manual** del número/CUFE hecho en el software actual (costo cero), **Factus** (emisión automática por API, sandbox gratis) o **webhook firmado** (Make, n8n u otro proveedor). Reintentos seguros, rechazo con motivo, anulación con nota crédito. *Facturación → Proveedor*. |
| 🚚 **Compras** | Facturas de proveedores **importando el XML de la factura electrónica DIAN** (se lee en el navegador; crea proveedor e insumos y recuerda los códigos del proveedor), registro manual, sin duplicados (número o CUFE), anulación con reversa del inventario. |
| 🧾 **Cuentas por pagar** | Saldo por factura, abonos a proveedores sin sobrepago, vencidas y por vencer en 7 días, Excel. |
| 📦 **Inventario** | Insumos con existencia calculada por movimientos (no se descuadra), costo promedio ponderado, mínimo y alerta "Pedir", ajustes (conteo, vencidos, inventario inicial), kardex, Excel. |
| 🧮 **Costo por servicio** | Receta de insumos por servicio, costo y margen. Al marcar la cita **atendida** se descuentan los insumos automáticamente (una sola vez). |
| 📈 **Indicadores** | Inasistencia, confirmación, ingresos de citas con recordatorio, recaudo, cartera, reservas en línea. |
| 🛡️ **Permisos granulares** | 40 permisos `módulo.recurso.acción`, roles editables, alcance "solo su agenda", protección contra escalamiento de privilegios, auditoría. |
| 🛡️ **Anti-reservas fantasma** | Verificación por WhatsApp con código de 6 dígitos, límite de reservas activas por documento y celular (atómico), liberación automática si no confirma, Turnstile opcional. *Configuración → Reservas en línea*. |
| 💳 **Pago anticipado (Wompi)** | Cada consultorio conecta su cuenta Wompi (*Configuración → Pagos en línea*) y elige en *Servicios* qué servicios exigen anticipo (porcentaje o valor fijo). Checkout firmado, confirmación verificada por evento y por API, recibo automático, alertas de pagos tardíos o dobles. |
| 💬 **WhatsApp** | Número del consultorio, plantilla editable con vista previa y prueba, detección de fijos. Sin costo (enlaces wa.me). |
| 🧭 **Panel del dueño** | En `/plataforma` (aplicación aparte, ingreso con correo + contraseña y verificación en dos pasos opcional con app autenticadora; la clave maestra solo crea la primera cuenta y recupera el acceso): resumen de ingresos, consultorios reales y demos con su uso, registrar pagos, cambiar plan y fechas, suspender o dar cortesía, restablecer la clave del administrador, auditoría y creación de demos en segundos. |
| 💰 **Suscripciones** | Cada consultorio real tiene "pagado hasta", valor mensual y días de gracia. Aviso 5 días antes, aviso en rojo durante la gracia y **suspensión automática** al terminar (el panel muestra el paso a paso para pagar; las reservas en línea se pausan; no se borra nada). Al registrar el pago —manual o **en línea con tu Wompi**— el acceso vuelve al instante. |
| 🎓 **Centro de aprendizaje** | Menú *Aprende a usarlo*: guía paso a paso de cada módulo, buscador, avance del usuario y **recorridos guiados** sobre la pantalla real. Botón (?) en cada vista y bienvenida en el primer ingreso. |
| 🌗 **Interfaz** | Modo día/noche, colores sobrios, íconos con explicación, instalable en el celular (PWA). |

---

## 🚀 1. Probar en tu computador (2 minutos)

Requisito: **Node.js 22.5 o superior** (recomendado: la versión LTS de nodejs.org).

```bash
npm install
npm run dev
```

La consola muestra el enlace de reservas y el usuario/contraseña del **consultorio demo** (también quedan en `data/credenciales-demo.txt`).

- Panel: http://localhost:8787/app
- Reservas: http://localhost:8787/c/consultorio-demo-sonrisa
- Modo vitrina: http://localhost:8787/plataforma (clave: `PLATFORM_ADMIN_KEY` del archivo `.env`)

La primera vez se crea automáticamente un archivo `.env` con secretos aleatorios (ver `.env.example` para todas las opciones).

---

## ☁️ 2. Publicar gratis en Cloudflare

1. Crea una cuenta gratuita en [cloudflare.com](https://dash.cloudflare.com/sign-up).
2. Inicia sesión desde la terminal:
   ```bash
   npx wrangler login
   ```
3. Crea la base de datos y copia el `database_id` que aparece en `wrangler.toml`:
   ```bash
   npx wrangler d1 create agenda-sonrisa
   ```
4. Guarda los secretos (te los pedirá en pantalla; usa cadenas largas y aleatorias):
   ```bash
   npx wrangler secret put APP_SECRET            # 32+ caracteres. No lo cambies después.
   npx wrangler secret put PLATFORM_ADMIN_KEY    # 24+ caracteres.
   ```
5. Crea las tablas y publica:
   ```bash
   npm run cf:migrate:remote
   npm run cf:deploy
   ```
6. Abre `https://agenda-sonrisa.<tu-subdominio>.workers.dev/plataforma` y crea tu primer consultorio o una demo.

> **Generar secretos:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### Copias de seguridad (gratis)
```bash
npx wrangler d1 export agenda-sonrisa --remote --output respaldo-$(date +%F).sql
```

---

## 🔁 3. CI/CD con GitHub Actions

El flujo `.github/workflows/ci-cd.yml` se ejecuta en cada cambio:

1. **Calidad:** tipos, lint de seguridad (0 advertencias), 153 pruebas, compilación, auditoría de dependencias y validación del paquete de Cloudflare.
2. **E2E:** levanta el Worker con el runtime real de Cloudflare + D1 local y ejecuta la prueba de humo (21 verificaciones).
3. **Despliegue:** solo en `main`, si configuraste los secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`. Aplica migraciones y publica.

Dependabot revisa actualizaciones de seguridad cada semana.

Para verificar todo localmente antes de subir:
```bash
npm run check
```

---

## 🖥️ 4. Alternativa: tu propio servidor (EC2 u otro)

El mismo código corre en Node con SQLite:

```bash
npm ci
cp .env.example .env      # completa APP_SECRET y PLATFORM_ADMIN_KEY
npm start                 # puerto 8787 por defecto
```

Ponlo detrás de Nginx con HTTPS y define `TRUST_PROXY=true`. Respaldo: copia el archivo `data/agenda-sonrisa.db`.

---

## 🧭 Cómo se usa (día a día)

1. **Configuración:** datos del consultorio, profesionales y su horario (hay plantilla de un clic), bloqueos.
2. **Servicios:** catálogo con precio y duración.
3. **Comparte el enlace de reservas** en WhatsApp, Instagram y Google Maps.
4. **Recordatorios:** cada tarde, envía los avisos de mañana con un clic por paciente.
5. **Agenda:** marca "Atendida" y se crea la cuenta por cobrar automáticamente.
6. **Caja:** registra pagos; el sistema abona a lo más antiguo y deja el excedente como anticipo.

### Para vender (modo vitrina)
Antes de visitar un consultorio, entra a `/plataforma`, escribe su nombre y color, y obtén una demo con su marca. En la reunión muéstrale la reserva desde su celular y el panel desde el tuyo (botón **Abrir panel** en Demos).

### Venta autogestionada (`/registro`)
Comparte `https://tu-dominio/registro` en tu web, redes o WhatsApp. Ahí el interesado:
1. Ve los **planes y precios** (mensual o anual con meses gratis).
2. Crea una **demo con datos de ejemplo** que dura 5 días (configurable). Cada día se le recuerda cuánto le queda y se le invita a crear su consultorio. Al vencer, la demo y sus datos se **borran solos** (también puedes borrarla o extenderla en **Demos**).
3. Crea su **consultorio real con prueba gratis**. Si lo hace desde la demo, la demo sigue abierta **24 horas** más.
4. Antes de terminar la prueba, paga desde **Mi plan** con tu Wompi. Sin intervención tuya.

Atajos: `/registro?accion=demo` abre la demo · `/registro?plan=profesional` preselecciona un plan.

### Planes y módulos
| Plan | Incluye | Profesionales / usuarios (ejemplo) |
|---|---|---|
| Básico | Agenda, pacientes, reservas en línea, recordatorios, servicios, usuarios | 1 / 2 |
| Profesional | Básico + Caja, cartera, indicadores, anticipos en línea | 3 / 6 |
| Completo | Profesional + Compras e inventario, facturación electrónica, auditoría | 5 / 12 |

- Precios, límites y módulos se editan en `/plataforma` → **Planes** (los valores iniciales son ejemplos).
- Adicionales para cualquier plan: módulos sueltos, profesional extra y usuario extra.
- Se cobra **por profesional con agenda** y con **límite de usuarios** por plan; al llegar al tope el sistema pide agregar adicionales o subir de plan.
- El plan recorta los permisos: un módulo que no está en el plan aparece con candado en el menú y el servidor responde 403.
- Cambio de plan desde **Mi plan**: en prueba o vencido → inmediato; subir estando al día → paga la diferencia de los días que quedan; bajar → se aplica al terminar lo ya pagado.
- Los consultorios que ya existían quedan en Completo con su valor actual como **precio especial** (no cambia).

---

## 🏗️ Arquitectura

```
src/
├── worker.ts / node/server.ts   # Entradas: Cloudflare Workers o Node (mismo código)
├── app.ts                       # Hono: middlewares de seguridad y rutas
├── services.ts                  # Contenedor de dependencias
├── db/                          # Contrato SQL estilo D1 + adaptador SQLite para Node
├── http/                        # Rutas, validación (Zod), errores, CSRF, registro de permisos
├── security/                    # PBKDF2, sesiones, permisos, límites de intentos, enlaces firmados
├── modules/                     # Lógica de negocio por dominio
│   ├── appointments/            # Disponibilidad, citas, lista de espera
│   ├── billing/                 # Cargos, recaudos, abonos, anticipos, cartera
│   ├── patients/ catalog/ professionals/ tenants/ users/ reports/ audit/ platform/
└── utils/                       # Fechas locales, festivos de Colombia
frontend/                        # TypeScript sin framework → public/assets (esbuild)
migrations/                      # Esquema SQL (D1 y SQLite)
tests/                           # Seguridad, negocio y frontend
scripts/                         # Compilación, desarrollo y prueba de humo
```

**Decisiones clave**
- **Multi-consultorio:** todas las tablas llevan `tenant_id`; cada consulta filtra por el consultorio de la sesión.
- **Portabilidad:** la lógica depende de una interfaz `SqlDatabase`; D1 en Cloudflare, SQLite en Node.
- **Dinero en pesos enteros** y registros financieros que nunca se borran (se anulan con motivo).
- **Agenda en hora local del consultorio** (`America/Bogota`), independiente del servidor.

### Permisos
Los permisos están en `src/security/permissions.ts`. Roles iniciales: **Administrador** (todo, no editable), **Recepción**, **Odontólogo** (solo su agenda) y **Auxiliar contable**. Crea los que necesites desde *Usuarios y roles*.

---

## 💰 Cobrar la suscripción a tus clientes

1. Entra a `/plataforma`. La primera vez creas tu cuenta de dueño con la clave maestra `PLATFORM_ADMIN_KEY`; desde ahí ingresas con tu correo y contraseña (activa la verificación en dos pasos en **Mi cuenta**). Luego ve a **Configuración**: tu nombre, tu WhatsApp, las instrucciones de pago (Nequi, cuenta bancaria), días de prueba y de gracia, y si el registro y las demos en línea están activos. Los precios están en **Planes**.
2. Opcional — pago en línea con **tu** Wompi: llaves del ambiente elegido y, en Wompi → Desarrolladores, la URL de eventos que muestra la pantalla (`/api/webhooks/wompi-plataforma`). Así tus clientes pagan desde su panel y se reactivan solos.
3. Al crear un consultorio real eliges su plan (o un precio especial) y hasta qué fecha tiene acceso (prueba). Los que se registran solos en `/registro` ya llegan con su plan y su prueba.
4. Cuando te paguen por transferencia: **Consultorios → Pago**. El acceso se reactiva de inmediato.

## 💳 Activar pagos con Wompi (por consultorio)

1. Aplica la migración nueva: `npm run cf:migrate:remote` (en Node se aplica sola al iniciar).
2. Panel → **Configuración → Pagos en línea**: pega llave pública, secreto de integridad y secreto de eventos (empieza en **Sandbox**).
3. Copia la **URL de eventos** que aparece y pégala en el panel de Wompi (Desarrolladores → URL de eventos).
4. **Probar conexión** → en **Servicios** define el anticipo.
5. Prueba con la tarjeta `4242 4242 4242 4242` (aprobada) o `4111 1111 1111 1111` (rechazada).
6. Cambia a Producción con las llaves de producción y actualiza la URL de eventos.

La llave privada de Wompi **no** se usa ni se guarda; los secretos quedan cifrados (AES-256-GCM).

## ⚠️ Límites conocidos

- **CPU del plan gratuito (10 ms por petición):** el cifrado de contraseñas (PBKDF2, 100.000 iteraciones) supera ese tiempo solo al **ingresar**. Cloudflare tolera excesos ocasionales; si al ingresar ves el error 1102, baja `PASSWORD_HASH_ITERATIONS` en `wrangler.toml` (ej. 50000). Las contraseñas se re-cifran solas en el siguiente ingreso.
- **WhatsApp:** los mensajes se envían con un clic (sin costo). El envío 100 % automático requiere la API oficial, que es paga.
- **Fuera de alcance:** historia clínica (regulación especial) y facturación electrónica DIAN (fase 3, mediante el proveedor del consultorio).
- Los recibos de caja son soporte de recaudo; no reemplazan la factura electrónica cuando sea exigible.

## 🗺️ Siguientes fases
- ✅ **Fase 2:** proveedores, compras con XML DIAN, cuentas por pagar, inventario y costo por servicio.
- ✅ **Fase 3:** facturación electrónica (manual, Factus o webhook).
- **Siguiente:** notas crédito desde el sistema, conectores Alegra/Siigo y facturación sector salud (RIPS) para EPS.

Ver [SECURITY.md](SECURITY.md) para el informe de auditoría.
