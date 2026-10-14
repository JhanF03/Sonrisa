# Informe de seguridad y auditoría — Fase 1

Fecha: 12 de octubre de 2026 · Alcance: backend (Hono), frontend, base de datos, configuración de despliegue y CI/CD.

## Resultado

| Verificación | Herramienta | Resultado |
|---|---|---|
| Tipos estrictos (Node, Worker y frontend) | `tsc --strict` | ✅ Sin errores |
| Lint de calidad y seguridad | ESLint + typescript-eslint + eslint-plugin-security | ✅ 0 errores, 0 advertencias |
| Pruebas automáticas | `node:test` (153 pruebas) | ✅ 153/153 |
| Dependencias con vulnerabilidades conocidas | `npm audit` | ✅ 0 (producción y desarrollo) |
| Esquema en el motor real de Cloudflare | `wrangler d1 migrations apply --local` | ✅ 37 sentencias aplicadas |
| Recorrido de extremo a extremo en runtime Cloudflare + D1 | `scripts/smoke-test.mjs` | ✅ 21/21 verificaciones |
| Paquete de despliegue | `wrangler deploy --dry-run` | ✅ 170 KB comprimido |

## Controles implementados y cómo se prueban

| Riesgo (OWASP) | Control | Prueba |
|---|---|---|
| Control de acceso roto | Cada ruta declara su permiso en un registro central; el servidor lo valida siempre. | Recorre **todas** las rutas: 401 sin sesión y 403 sin permiso. |
| Acceso a datos de otro consultorio (IDOR) | Toda consulta filtra por `tenant_id` de la sesión. | Lectura, citas, pagos y roles cruzados entre consultorios → 404. |
| Escalamiento de privilegios | Nadie otorga permisos que no tiene; nadie edita ni cambia la clave de alguien con más permisos; rol Administrador inmutable; siempre queda un admin activo. | Recepción con gestión de usuarios no puede crear superroles, asignarse Administrador ni tomar la cuenta del admin. |
| Alcance por profesional | Con "ver solo su agenda", consultas y cambios se restringen a su perfil. | El odontólogo no ve ni modifica citas de otro profesional. |
| Inyección SQL | 100 % sentencias parametrizadas; comodines de `LIKE` escapados; identificadores validados. | Ataques `' OR 1=1 --`, `DROP TABLE`, `%`, `_`. |
| XSS | Plantillas que escapan todo por defecto; URLs filtradas (`javascript:`, `data:` bloqueadas); CSP `script-src 'self'`. | Pruebas del motor de plantillas y de `safeUrl`. |
| CSRF | Cookie `SameSite=Strict` + cabecera obligatoria + verificación de `Origin`. | Peticiones sin cabecera o de otro origen → 403. |
| Contraseñas | PBKDF2-SHA256 con sal (100.000 iteraciones), política de 10+ caracteres con letras y números, comparación en tiempo constante, re-cifrado automático al cambiar el costo. | Formato del hash, verificación y re-cifrado. |
| Fuerza bruta | Límite por IP y por correo; la IP no se puede falsificar sin proxy de confianza. | 429 tras intentos repetidos, incluso rotando `X-Real-IP`. |
| Enumeración de usuarios | Mismo mensaje y tiempo similar para usuario inexistente o clave incorrecta. | Mensajes idénticos. |
| Sesiones | Token aleatorio de 256 bits; en la base solo su hash; HttpOnly, Secure en HTTPS; expiración y cierre en el servidor; se revocan al desactivar o cambiar la clave. | Logout invalida; desactivar usuario cierra sesiones. |
| Enlaces de cita | Firma HMAC-SHA256 (no se guardan tokens); comparación en tiempo constante. | Enlaces alterados o con otro secreto → rechazados. |
| Datos personales (Ley 1581) | Autorización registrada con fecha, versión y canal; la reserva pública no sobrescribe datos de pacientes existentes; respuestas públicas sin teléfonos ni documentos. | Pruebas de no sobrescritura y de privacidad. |
| Bots y abuso | Campo trampa, límite de reservas y consultas por IP, límite de tamaño del cuerpo (64 KB). | Bots, límite de reservas y cuerpo grande. |
| Dobles reservas | Tres capas: sentencia SQL atómica, triggers en la base que rechazan cualquier cruce aunque falle el código, y una única regla de "cupo ocupado". | 8 reservas simultáneas → 1 éxito; INSERT/UPDATE directos en la base → rechazados. |
| Reservas fantasma | Retenciones con vencimiento (pago, verificación, confirmación) que liberan el cupo al instante; límite por documento y celular en la misma sentencia atómica; Turnstile opcional. | 6 reservas simultáneas de la misma persona con límite 2 → exactamente 2. |
| Pagos (Wompi) | Firma de integridad en el servidor; eventos validados con checksum; la redirección se verifica contra la API de Wompi; recibo idempotente (índice único); secretos cifrados por consultorio. | Vector oficial de integridad; eventos falsos/otro ambiente/monto distinto rechazados; webhook + redirección simultáneos → 1 recibo. |
| Cabeceras | CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS en HTTPS, `no-store` en la API. | Presentes incluso en respuestas de error. |
| Trazabilidad | Auditoría de accesos, anulaciones, precios, permisos y exportaciones. Nada financiero se borra. | Anulación registrada en auditoría. |
| Secretos | Solo en `wrangler secret` o `.env` (excluidos de git); el arranque falla si `APP_SECRET` es débil. | Validación de configuración. |

## Riesgos residuales (conocidos y aceptados en esta fase)

1. **CPU del plan gratuito:** el ingreso puede superar los 10 ms de CPU por el cifrado de contraseñas. Cloudflare tolera excesos ocasionales; si aparece el error 1102, reduce `PASSWORD_HASH_ITERATIONS`. Las contraseñas se re-cifran solas en el siguiente ingreso.
2. **Sin doble factor (2FA):** planeado para una fase posterior.
3. **Enlace de cita = acceso a esa cita:** quien tenga el enlace puede confirmarla, reprogramarla o cancelarla. Es el comportamiento estándar de estos sistemas; el enlace no expone datos sensibles.
4. **Ataques distribuidos de fuerza bruta** (muchas IP): mitigados por la política de contraseñas y el límite por correo.
5. **Demos del modo vitrina** se acumulan en la base. Conviene limpiarlas periódicamente.

## Cómo repetir la auditoría

```bash
npm run check                       # tipos, lint, pruebas, compilación y npm audit
npm run cf:verify                   # paquete de Cloudflare
npm run cf:dev                      # en otra terminal, luego:
node scripts/smoke-test.mjs http://localhost:8787 <PLATFORM_ADMIN_KEY>
```
