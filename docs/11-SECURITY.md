# BenHouse v0.4 — Seguridad

## Objetivo

Definir los requisitos de seguridad obligatorios de BenHouse v0.4 desde el inicio de la construcción.

Este documento debe impedir:

- secretos hardcodeados;
- autorización insuficiente;
- acceso a recursos ajenos;
- mass assignment;
- sesiones inseguras;
- webhooks falsificados;
- uploads inseguros;
- exposición de documentos;
- confirmaciones económicas manipulables;
- errores que filtren información;
- uso incorrecto de datos sensibles;
- introducir “hardening” únicamente al final.

La seguridad forma parte de la arquitectura y de la Definition of Done.

---

# 1. Principio maestro

Toda acción crítica debe evaluarse mediante:

AUTENTICACIÓN
+
AUTORIZACIÓN
+
RELACIÓN CON EL RECURSO
+
ESTADO
+
REQUISITOS
+
VALIDACIÓN DE INPUT
+
AUDITORÍA CUANDO CORRESPONDA

Frontend nunca es autoridad de seguridad.

---

# 2. Modelo de amenazas inicial

BenHouse v0.4 debe asumir al menos estos actores:

- usuario anónimo;
- usuario autenticado malicioso;
- usuario intentando acceder a recursos ajenos;
- profesional intentando superar límites de organización;
- antiguo miembro de organización;
- atacante automatizado;
- webhook falsificado;
- usuario manipulando requests;
- usuario intentando duplicar pagos/acciones;
- actor interno/admin con exceso de privilegios;
- proveedor externo comprometido o fallando.

No diseñar únicamente para usuarios cooperativos.

---

# 3. Autenticación

La autenticación debe utilizar:

- sesiones seguras;
- cookies HttpOnly;
- Secure en entornos HTTPS;
- SameSite adecuado;
- expiración;
- revocación;
- logout;
- renovación segura cuando corresponda.

No mostrar JWT al usuario.

No requerir copiar/pegar tokens.

No guardar tokens sensibles en localStorage si la estrategia oficial utiliza cookies HttpOnly.

---

# 4. Passwords

Requisitos:

- hash mediante algoritmo moderno adecuado;
- nunca almacenar texto plano;
- nunca loggear;
- reglas mínimas razonables;
- rate limiting en login;
- recuperación segura.

El algoritmo concreto puede utilizar Argon2id o equivalente moderno compatible con el stack.

---

# 5. Registro

`POST /auth/register` debe impedir:

- establecer admin;
- establecer verification;
- establecer status privilegiado;
- elegir roles internos;
- mass assignment.

Validar:

- email;
- contraseña;
- campos permitidos.

---

# 6. Login

Debe tener:

- rate limiting;
- respuesta segura;
- protección frente a fuerza bruta;
- logging técnico sin secretos.

No revelar excesivamente si:

- email existe;
- contraseña concreta es incorrecta.

La UX puede seguir siendo comprensible sin facilitar enumeración.

---

# 7. Recuperación de contraseña

Forgot password:

- token de un solo uso;
- expiración;
- almacenamiento seguro/hashed cuando corresponda;
- respuesta anti-enumeration.

Reset password:

- valida token;
- invalida después de uso;
- revoca sesiones cuando corresponda.

---

# 8. Verificación de email

Tokens:

- expirables;
- de un solo uso;
- no predecibles.

No confiar en frontend para establecer `verified`.

---

# 9. Sesiones

La sesión debe almacenar/representar únicamente lo necesario.

Debe soportar:

- revocación;
- expiración;
- logout;
- múltiples sesiones cuando la política lo permita.

Cambios críticos como:

- password reset;
- bloqueo de cuenta;
- revocación administrativa;

pueden invalidar sesiones activas.

---

# 10. CSRF

Si la autenticación utiliza cookies:

aplicar protección CSRF adecuada según arquitectura.

Opciones:

- SameSite;
- CSRF token cuando sea necesario;
- validación Origin/Referer en acciones sensibles.

La estrategia final debe documentarse durante implementación.

No asumir que HttpOnly resuelve CSRF.

---

# 11. CORS

Configurar explícitamente por entorno.

No utilizar:

`cors: true`

indiscriminadamente en producción.

Permitir únicamente origins necesarios.

Separar:

- local;
- staging;
- production.

Credentials únicamente cuando proceda.

---

# 12. Security headers

Aplicar headers de seguridad apropiados.

Ejemplos:

- Content-Security-Policy;
- X-Content-Type-Options;
- Referrer-Policy;
- Permissions-Policy;
- frame-ancestors/CSP;
- HSTS en producción HTTPS cuando corresponda.

Configurar según necesidades de:

- Google Maps;
- PSP;
- firma;
- storage.

No utilizar CSP tan abierta que pierda utilidad.

---

# 13. Content Security Policy

Debe contemplar únicamente dominios externos necesarios.

Especial atención:

- scripts Google Maps;
- payment widgets;
- signature widgets;
- image CDN/storage.

No utilizar:

`script-src *`

o equivalentes inseguros.

---

# 14. Autorización

Todas las rutas privadas realizan autorización backend.

Reglas definidas en `05-PERMISSIONS.md`.

No confiar en:

- UI hidden;
- route guards frontend;
- resource IDs difíciles de adivinar.

Conocer el ID nunca concede acceso.

---

# 15. IDOR / BOLA

Obligatorio proteger:

- Properties;
- Listings;
- Offers;
- Operations;
- Contracts;
- Signatures;
- Payments;
- Documents;
- Conversations;
- Leads;
- Organization resources.

Test negativo obligatorio para cada recurso sensible.

---

# 16. Identidad derivada de sesión

Nunca aceptar como actor autoritativo desde body:

- userId;
- ownerId;
- senderId;
- bidderId;
- payerId;
- signerId;
- fromUserId.

El backend obtiene actor desde sesión/service identity.

---

# 17. Mass assignment

Campos sensibles adicionales: `PropertyAuthorization.authorizationType`, `PropertyAuthorization.status`, datos de ownership/delegación, `publisherUserId`, `publisherOrganizationId` y `responsibleMemberUserId`.

Tests obligatorios: ownership forgery (`ownerId` ajeno); publicación sobre Property ajena; contexto falso de Organization; delegación revocada; y responsible member que no pertenece activamente a la Organization publisher. Todos deben rechazarse.

DTOs explícitos.

Prohibido pasar directamente:

`request.body`

a Prisma create/update cuando contenga campos sensibles potenciales.

Campos críticos protegidos:

- role/capability;
- admin;
- status;
- ownership;
- verification;
- financial values;
- operation states;
- provider references;
- trust.

---

# 18. DTO validation

NestJS debe utilizar validación global.

Requisitos:

- whitelist;
- reject/strip unexpected fields según política;
- transform seguro;
- tipos claros;
- límites.

No utilizar `any` en DTOs críticos.

---

# 19. Input validation

Validar:

- strings;
- emails;
- números;
- fechas;
- enums;
- arrays;
- URLs;
- filtros;
- JSON estructurado.

Aplicar límites de longitud.

Evitar payloads gigantes.

---

# 20. Output validation/projections

No devolver automáticamente objetos de base de datos completos.

Cada endpoint define proyección.

Eliminar:

- password hashes;
- provider secrets;
- private IDs innecesarios;
- document metadata sensible;
- internal trust signals;
- audit internals;
- payment-sensitive data.

---

# 21. SQL Injection

Prisma reduce riesgo si se utiliza correctamente.

Evitar raw SQL no parametrizado.

Cuando PostGIS requiera SQL raw:

- parametrizar;
- encapsular;
- revisar;
- testear.

No concatenar polígonos/query strings directamente en SQL.

---

# 22. XSS

Todo contenido generado por usuarios debe tratarse como no confiable.

Ejemplos:

- property descriptions;
- messages;
- CRM notes;
- user names;
- listing content.

React escapa por defecto.

Evitar `dangerouslySetInnerHTML` salvo sanitización explícita.

Si se soporta rich text:

sanitizar mediante librería adecuada.

---

# 23. Stored XSS

Especial atención a:

- listings;
- messages;
- notes;
- templates;
- AI-generated explanations.

No confiar en contenido porque proviene de base de datos.

---

# 24. AI output security

La salida de AIProvider es no confiable.

Validar/sanitizar antes de renderizar cuando corresponda.

No permitir que IA genere:

- HTML arbitrario;
- scripts;
- enlaces inseguros.

No enviar secrets ni documentación privada al AIProvider salvo aprobación explícita futura.

---

# 25. Prompt injection

Cuando AIProvider procese datos externos o texto del usuario:

no permitir que ese contenido cambie reglas de sistema.

La IA no tiene capacidad directa para:

- cambiar estado;
- ejecutar pago;
- aceptar oferta;
- acceder a documentos;
- cambiar permisos.

AIProvider es capa explicativa, no agente privilegiado.

---

# 26. Rate limiting

Aplicar límites específicos a:

- register;
- login;
- forgot-password;
- reset-password;
- verify-email;
- verify-phone;
- messaging;
- visits;
- offers;
- bids;
- uploads;
- analytics;
- webhooks según proveedor.

Límites configurables por entorno.

---

# 27. Abuse protection

Además de rate limits, considerar:

- spam de mensajes;
- spam de visitas;
- spam de ofertas;
- abuso de búsquedas;
- abuso de uploads;
- pujas automatizadas.

v0.4 necesita protección básica, no sistema antifraude enterprise.

---

# 28. File uploads

Todo upload debe validar:

- autenticación;
- autorización;
- resource ownership;
- MIME;
- tamaño;
- tipo esperado;
- extensión cuando corresponda.

No confiar en nombre de archivo.

---

# 29. Upload paths

Nunca permitir que cliente defina libremente storage path completo.

Backend genera ubicación segura.

Prevenir:

- path traversal;
- overwrite arbitrario;
- acceso cross-user.

---

# 30. Public media

Fotografías públicas pueden servirse mediante URL/CDN.

Pero:

- upload autorizado;
- ownership;
- tipos permitidos;
- size limits;
- metadata controlada.

---

# 31. Private documents

Tests obligatorios: grant spoofing, subject spoofing, grant expirado/revocado, grant V1 sin acceso automático a V2, overwrite de storageKey histórico y autovalidación. Campos protegidos: family, version, supersedes, status, validatedAt, grant subject/purpose/status.

DNI, contratos y documentación:

- storage privado;
- sin URL pública permanente;
- download-intent;
- autorización;
- signed URL temporal;
- expiración;
- audit cuando corresponda.

---

# 32. Sensitive document access

Registrar cuando sea apropiado:

- actor;
- documentId;
- purpose;
- timestamp;
- result.

No loggear documento ni URL firmada completa cuando contenga token sensible.

---

# 33. Storage signed URLs

Deben:

- expirar;
- limitar operación;
- limitar objeto;
- no ser reutilizables indefinidamente.

No persistir signed URL como URL permanente de Document.

Persistir `storageKey`.

---

# 34. Malware

Para v0.4:

al menos arquitectura compatible con escaneo futuro.

Si storage/proveedor permite integración básica sin complejidad excesiva, puede utilizarse.

No bloquear MVP construyendo pipeline antivirus enterprise.

Clasificar como P1 solo si el hosting/uso demo expone riesgo real.

---

# 35. Payments

Payment protege amount, currency, payer y estado; PaymentAttempt protege provider, referencias, idempotency, estado y fallo contra mass assignment. Tests: Attempt IDOR, status spoof CONFIRMED, provider-reference spoof, key duplicada, retry cross-user y retry tras CONFIRMED. Webhook localiza y valida Attempt antes de reevaluar Payment/Operation; nunca actualiza Payment directamente. FAILED es histórico: retry crea Attempt nuevo.

Payment security es crítica aunque sea sandbox.

Reglas:

- amount calculado backend;
- currency validada;
- payer validado;
- providerReference interno;
- webhook verificado;
- idempotencia;
- no almacenar datos de tarjeta.

BenHouse no debe tocar PAN/CVV.

Utilizar PSP-hosted components/session.

---

# 36. PCI scope

Reducir alcance PCI utilizando proveedor externo.

No construir formularios propios que procesen datos de tarjeta directamente en backend.

v0.4 sandbox debe seguir arquitectura compatible con producción segura futura.

---

# 37. Payment webhook

Verificación criptográfica obligatoria.

Debe comprobar:

- signature;
- raw body;
- providerEventId;
- idempotencia;
- resource reference;
- estado compatible.

Webhook inválido:

rechazar.

---

# 38. Payment replay

Un mismo provider event:

procesar una vez lógicamente.

La repetición debe devolver respuesta segura sin duplicar efectos.

---

# 39. Payment amount tampering

Caso obligatorio:

frontend modifica amount de:

6.000 €
a
1 €.

Backend debe ignorar/rechazar.

El importe se recalcula desde Operation/rules.

---

# 40. Signature security

Signer se determina por Contract/Signature + sesión.

No aceptar signerId arbitrario.

SignatureProvider confirma estado.

No permitir:

“mark signed”.

---

# 41. Signature links

Sesiones/links deben:

- expirar;
- estar ligados al signer;
- no exponerse públicamente;
- utilizar Provider seguro.

No compartir un único link permanente para todas las partes.

---

# 42. Verification/KYC

Datos KYC minimizados.

No almacenar documentación adicional si no es necesaria.

ProviderReference + resultado interno preferidos.

Mock KYC prohibido en producción real.

---

# 43. Webhook security general

Aplicar a:

- Payment;
- Signature;
- Identity.

Flujo:

raw request
→ verify signature
→ validate timestamp/event
→ deduplicate
→ normalize
→ service
→ domain transition.

No hacer update directo desde controller.

---

# 44. Secrets

Secrets únicamente en:

- environment;
- secret manager/hosting seguro.

Nunca:

- código;
- frontend;
- logs;
- screenshots;
- test fixtures commiteadas.

---

# 45. Environment validation

La aplicación debe fallar al arrancar si falta configuración crítica.

No utilizar fallback inseguro:

`JWT_SECRET || "secret"`

Mock providers deben necesitar configuración explícita.

---

# 46. Public environment variables

Toda variable `NEXT_PUBLIC_*` debe asumirse visible públicamente.

Solo colocar:

- valores públicos;
- IDs/keys explícitamente publicables.

Nunca secrets.

---

# 47. Logs

Logs estructurados.

Nunca registrar:

- password;
- session cookie;
- refresh token;
- full JWT;
- API secrets;
- private signed URL;
- card data;
- full KYC payload;
- documents.

---

# 48. PII in logs

Minimizar:

- emails;
- teléfonos;
- nombres.

Cuando sean necesarios para debugging, preferir:

- userId;
- masked values.

---

# 49. Error handling

Producción no devuelve:

- stack;
- SQL;
- Prisma internals;
- provider secrets;
- filesystem paths.

Dev puede mostrar más información localmente.

Formato API consistente.

---

# 50. Resource enumeration

Evitar respuestas que permitan enumerar recursos privados.

Cuando corresponda:

devolver 404 aunque exista si actor no debe conocerlo.

No aplicar mecánicamente; policy por recurso.

---

# 51. IDs

Utilizar IDs no predecibles.

Esto reduce enumeración casual.

No sustituye autorización.

---

# 52. Organization isolation

Organization A no accede a datos de B.

Especialmente:

- leads;
- CRM notes;
- portfolio;
- analytics;
- operations;
- messages.

Tests cross-tenant obligatorios.

---

# 53. Membership revocation

Cuando un miembro es eliminado:

sus permisos derivados dejan de funcionar inmediatamente o dentro de semántica segura definida.

No depender únicamente de claims de sesión obsoletos durante días.

Reconsultar/autorización adecuada para recursos críticos.

---

# 54. Admin security

No utilizar:

`if (user.isAdmin) return true`

como única política.

Capabilities administrativas.

Admin actions críticas:

- reason;
- AuditEvent;
- minimum privilege.

---

# 55. Admin impersonation

No implementar impersonation en v0.4 salvo necesidad P1 aprobada.

Evita riesgo innecesario.

---

# 56. Admin financial actions

Admin no puede:

- inventar PAYMENT_CONFIRMED;
- cambiar amount arbitrariamente;
- falsificar firma;
- borrar Commission history.

Cualquier herramienta de soporte debe respetar provider/domain.

---

# 57. Audit log

AuditEvent debe ser append-oriented.

No permitir edición/borrado desde UI normal.

Proteger acceso.

No incluir secrets.

---

# 58. Audit tampering

Las acciones administrativas sobre AuditEvent están fuera de alcance normal.

Si se necesita mantenimiento técnico:

debe ocurrir fuera de producto y quedar controlado.

---

# 59. Domain state manipulation

No endpoints:

- mark-payment-confirmed;
- mark-contract-signed;
- mark-verification-complete;
- set-operation-status.

Las transiciones pasan por comandos aprobados.

---

# 60. Concurrency

Proteger participant injection, Organization injection, provenance tampering y creación duplicada desde la misma Offer/Auction. `createdVia`, fuentes, participants, roles, estados y `agreedAmount` no son editables mediante DTO genérico.

Seguridad también implica integridad.

Proteger:

- double offer acceptance;
- double payment;
- auction close race;
- duplicated webhook;
- concurrent operation transitions.

Utilizar:

- transaction;
- locks/versioning;
- unique;
- idempotency.

---

# 61. Idempotency key security

Idempotency-Key:

- scope por actor/action;
- tamaño limitado;
- no confiar como autenticación;
- almacenar resultado seguro;
- impedir key collision cross-user.

Misma key + payload diferente:

rechazar.

---

# 62. Search abuse

Search endpoint:

- límites;
- validated filters;
- bounded page size;
- polygon complexity limit;
- query timeout cuando sea necesario.

Evitar consultas geoespaciales arbitrariamente costosas.

---

# 63. Polygon security

Validar:

- formato;
- número máximo de puntos;
- geometría válida;
- tamaño razonable.

No aceptar polígonos gigantes/auto-intersectados que derriben DB.

---

# 64. Prisma query exposure

No convertir query params directamente en:

where/orderBy

sin whitelist.

No exponer relaciones Prisma como query API general.

---

# 65. Pagination limits

Definir máximo de:

- pageSize;
- messages;
- search;
- audit;
- activity.

No permitir:

`limit=1000000`.

---

# 66. Messaging security

Validar:

- participant;
- message length;
- rate;
- content.

No permitir enviar a conversaciones ajenas.

No permitir modificar senderId.

---

# 67. CRM notes

Tratar como contenido privado.

No indexar públicamente.

No enviar a AIProvider automáticamente.

---

# 68. AI privacy

Antes de enviar datos al AIProvider:

minimizar.

Preferir:

- metrics;
- aggregated data;
- non-sensitive context.

No enviar:

- DNI;
- contratos privados;
- emails;
- teléfonos;
- payment data;
- KYC.

salvo futuro flujo explícito, revisado y autorizado.

---

# 69. Analytics privacy

AnalyticsEvent debe minimizar PII.

No meter texto completo de mensajes.

No meter documentos.

No utilizar analytics como storage secundario de datos sensibles.

---

# 70. Demand privacy

DemandSignal usado para Intelligence debe priorizar:

- agregación;
- anonimización/pseudonimización cuando corresponda.

Profesionales reciben demanda agregada o leads legítimos.

No revelar historial de búsqueda privado de usuarios.

---

# 71. Trust privacy

TrustEvidence puede contener información sensible.

La API pública devuelve proyección segura.

No publicar:

- incidentes;
- fraude;
- pesos;
- señales internas.

---

# 72. Data retention

v0.4 debe distinguir recursos que:

- pueden eliminarse;
- pueden archivarse;
- deben conservar histórico.

La política jurídica final se validará antes de producción comercial.

No implementar borrado indiscriminado.

---

# 73. Account deletion

El diseño futuro debe contemplar derechos de privacidad.

Pero una eliminación de cuenta no puede necesariamente borrar:

- operaciones;
- contratos;
- pagos;
- auditoría;

si existe obligación de retención.

v0.4 puede implementar flujo demo/básico o dejarlo preparado si no es necesario para demo.

No inventar política legal.

---

# 74. Data export

No es requisito central de demo.

Arquitectura debe evitar impedir futuras solicitudes de acceso/exportación.

No construir sistema completo ahora salvo necesidad legal previa al lanzamiento real.

---

# 75. Backups

Antes de staging serio/production:

PostgreSQL debe tener estrategia de backup.

Storage privado también.

Separar:

- backup;
- retention;
- restore test.

No asumir que proveedor cloud elimina necesidad de estrategia.

---

# 76. Restore

Un backup no es suficiente si no puede restaurarse.

Antes de producción real:

realizar prueba de restore.

Para MVP local, documentar estrategia.

---

# 77. Database access

Aplicaciones deben usar usuarios DB con permisos adecuados.

No utilizar superuser de PostgreSQL como credencial normal de aplicación en production.

Migrations pueden necesitar contexto distinto.

---

# 78. Network exposure

PostgreSQL no debe quedar expuesto públicamente sin necesidad.

Storage privado controlado.

Internal APIs protegidas.

---

# 79. Internal endpoints

`/internal/*` no son seguros solo por nombre.

Requieren:

- auth de servicio;
- red/secret adecuado;
- mínimo privilegio.

No exponer directamente a internet sin protección.

---

# 80. Health endpoints

`/health` no debe revelar:

- secrets;
- connection strings;
- versiones sensibles innecesarias;
- proveedor credentials.

Puede indicar:

- healthy;
- degraded;
- dependencies status seguro.

---

# 81. Dependency security

Durante construcción:

- lockfile;
- dependencias necesarias;
- evitar paquetes abandonados cuando exista alternativa razonable;
- revisar vulnerabilidades.

No actualizar automáticamente major versions sin evaluación.

---

# 82. Supply chain

No ejecutar scripts/copiar código desconocido sin revisión.

Codex debe preferir:

- librerías conocidas;
- oficiales;
- mantenidas.

Evitar dependencias triviales innecesarias.

---

# 83. Git security

Cuando Git se inicialice:

`.gitignore` debe excluir:

- `.env`;
- secrets;
- build output;
- local DB data;
- private uploads;
- logs;
- test artifacts sensibles.

Nunca commit de credenciales.

---

# 84. Seed security

Seeds demo:

- solo entorno permitido;
- passwords demo controladas;
- claramente identificadas;
- nunca production.

No utilizar `demo1234` como credencial production.

---

# 85. Demo accounts

Si staging tiene cuentas demo:

- no reutilizar credenciales reales;
- no reutilizar datos personales reales;
- no almacenar documentos reales;
- limitar entorno.

---

# 86. Synthetic data

Datos sintéticos deben marcarse.

No combinar con métricas reales sin separación.

Evita fraude informativo y errores de producto.

---

# 87. Client-side trust boundaries

Todo lo que llega desde navegador es no confiable:

- price;
- status;
- userId;
- flags;
- form hidden fields;
- frontend permissions;
- local state.

Backend vuelve a validar.

---

# 88. Server Components / frontend data

Si Next.js usa Server Components:

no enviar secrets al cliente por serialización accidental.

Revisar fronteras server/client.

No importar módulos server-only desde client components.

---

# 89. API base URLs

Browser debe utilizar URL accesible desde navegador.

No configurar URLs internas de Docker como:

`http://api:4000`

para requests client-side en producción/staging.

Separar:

- server internal URL;
- public API URL

si la arquitectura lo requiere.

---

# 90. Docker security

Cuando se implemente:

- imágenes mínimas razonables;
- no ejecutar como root cuando sea práctico;
- no incluir `.env` en imagen;
- healthchecks;
- secrets fuera de Dockerfile;
- DB password no hardcodeado.

No sobreoptimizar antes de scaffold funcional.

---

# 91. Docker Compose local

Puede exponer servicios en localhost.

No usar configuración local como plantilla directa de producción.

---

# 92. SSRF

Cualquier función backend que acepte URLs externas debe validar destinos.

Especialmente:

- media import futura;
- webhook callbacks futuros;
- fetch AI/content.

v0.4 debe evitar fetch arbitrario proporcionado por usuario.

---

# 93. Open redirect

Login/reset/payment/signature return URLs deben estar allowlisted o construidas internamente.

No aceptar redirect URL arbitraria.

---

# 94. Email links

Verify/reset links:

- token seguro;
- origin configurado;
- expiry;
- one-time use.

No construir URL desde Host header no confiable.

---

# 95. Cookie security

Cookies sensibles:

- HttpOnly;
- Secure production;
- SameSite adecuado;
- Path restringido cuando tenga sentido.

No colocar datos de usuario privados directamente dentro de cookies legibles.

---

# 96. Clickjacking

Utilizar CSP/frame-ancestors.

Permitir embedding externo solo cuando integración específica lo requiera.

BenHouse no debe ser embebible por cualquier dominio.

---

# 97. MIME sniffing

Aplicar:

`X-Content-Type-Options: nosniff`

y servir contenidos con MIME correcto.

---

# 98. Image privacy

No utilizar metadatos EXIF sensibles de imágenes subidas sin revisión.

Puede ser recomendable eliminar metadata no necesaria.

Especialmente geolocation EXIF en fotos privadas/no deseadas.

Puede implementarse como P1 si pipeline de imágenes lo facilita.

---

# 99. Document filenames

No confiar/exponer nombre original si contiene información sensible.

Guardar display name seguro y storage key interna.

---

# 100. Security events

Eventos técnicos de seguridad pueden incluir:

- login failed;
- rate limit;
- webhook invalid;
- permission denied;
- admin critical action;
- document sensitive access.

No necesitan todos convertirse en DomainEvent.

Pueden ir a security logging/audit.

---

# 101. Monitoring

Alertar cuando corresponda:

- aumento de 5xx;
- webhook invalid spikes;
- login abuse;
- worker dead letters;
- payment webhook failures;
- repeated authorization failures;
- storage failures.

No construir SIEM propio.

---

# 102. Incident response

Antes de producción real, definir:

- cómo revocar keys;
- cómo desactivar provider;
- cómo bloquear usuario;
- cómo detener pagos;
- cómo preservar logs;
- cómo restaurar servicio.

v0.4 puede documentar procedimientos básicos.

---

# 103. Feature flags de emergencia

Puede existir mecanismo para desactivar:

- payments;
- auctions;
- AI;
- signatures;
- KYC;

sin redesplegar si la infraestructura lo permite de forma sencilla.

No usar flags como sistema de permisos.

---

# 104. Dependency on external providers

Si proveedor crítico está caído:

mostrar estado recuperable.

No degradar hacia flujo inseguro.

Ejemplo:

PSP caído
≠
“marcar pago manualmente”.

---

# 105. Legal/security boundary

La implementación técnica segura no sustituye revisión jurídica.

Antes de dinero/contratos reales validar:

- GDPR;
- LOPDGDD;
- eIDAS/firma;
- KYC/AML si aplica;
- pagos;
- comisión;
- conservación;
- consentimiento;
- políticas de privacidad.

No afirmar cumplimiento jurídico definitivo sin revisión.

---

# 106. Threat-model checkpoints

Antes de terminar cada bloque crítico revisar:

## Identity
- session hijacking;
- enumeration;
- privilege escalation.

## Marketplace
- ownership;
- IDOR;
- upload;
- XSS.

## Transactions
- race;
- payment tampering;
- signature impersonation;
- state bypass.

## Professional
- organization isolation;
- data leakage.

## Admin
- excessive privilege;
- audit.

---

# 107. Security tests obligatorios

Debe existir cobertura para:

1. login rate limit;
2. invalid session;
3. expired session;
4. CSRF cuando aplique;
5. wrong CORS origin cuando aplique;
6. Property ajena;
7. Listing ajeno;
8. Conversation ajena;
9. Offer ajena;
10. Operation ajena;
11. Document ajeno;
12. Contract ajeno;
13. Signature ajena;
14. Payment ajeno;
15. Lead de otra Organization;
16. revoked member;
17. mass assignment;
18. invalid webhook;
19. duplicate webhook;
20. payment amount tampering;
21. state transition bypass;
22. invalid upload MIME;
23. oversized upload;
24. storage signed URL authorization;
25. admin without capability.

---

# 108. P0 security definition

Se considera P0 cualquier fallo que permita:

- acceso no autorizado a documentación;
- acceso cross-user/cross-organization sensible;
- privilege escalation;
- pago manipulado;
- firma por otra persona;
- estado económico falsificado;
- secreto expuesto;
- bypass masivo de autenticación;
- pérdida/corrupción crítica de datos;
- ejecución remota grave.

P0 bloquea avance.

---

# 109. P1 security definition

P1 incluye:

- falta de rate limiting en endpoint sensible;
- error de autorización limitado pero significativo;
- información sensible excesiva;
- missing audit crítico;
- upload débil;
- protección de replay ausente donde sea necesaria;
- configuración insegura que impida staging seguro.

P1 debe corregirse antes de cerrar el bloque.

---

# 110. Security checklist por PR/cambio

Antes de aceptar cambio sensible preguntar:

1. ¿qué input nuevo acepta?
2. ¿quién puede llamar?
3. ¿qué recurso puede tocar?
4. ¿qué información devuelve?
5. ¿hay mass assignment?
6. ¿hay IDOR?
7. ¿hay race?
8. ¿hay secret?
9. ¿requiere audit?
10. ¿qué ocurre si se repite request?
11. ¿qué ocurre si provider falla?
12. ¿hay test negativo?

---

# 111. Criterio de cierre de seguridad

La seguridad de v0.4 se considera suficientemente implementada para demo/staging cuando:

- sesiones son seguras;
- autorización backend cubre todos los recursos sensibles;
- IDOR/BOLA tiene tests;
- mass assignment está prevenido;
- secretos están aislados;
- documentos son privados;
- uploads están controlados;
- pagos no son manipulables;
- webhooks son verificados e idempotentes;
- firma no puede falsificarse desde frontend;
- Organizations están aisladas;
- Admin aplica mínimo privilegio;
- logs no contienen secretos;
- errores no filtran internals;
- P0/P1 están resueltos;
- tests de seguridad críticos pasan.

Esto NO equivale todavía a certificación o validación legal de producción comercial real.
