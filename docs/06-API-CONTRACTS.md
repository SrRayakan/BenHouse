# BenHouse v0.4 — Contratos de API

## Objetivo

Definir las acciones HTTP y contratos funcionales principales de BenHouse v0.4.

Este documento no pretende describir cada DTO final ni cada campo de respuesta, sino establecer:

- responsabilidades de cada endpoint;
- reglas de autorización;
- transiciones críticas;
- idempotencia;
- relación con eventos;
- consistencia entre frontend y backend;
- límites entre dominios.

Los endpoints concretos pueden ajustarse ligeramente durante implementación si existe una razón técnica P1, pero no deben alterar el comportamiento de negocio aprobado.

---

# 1. Principios generales

## 1.1 El backend es autoridad

El frontend puede solicitar una acción.

El backend decide:

- si el actor está autenticado;
- si tiene permiso;
- si el recurso existe;
- si el estado permite la acción;
- si los requisitos están completos;
- si la transición es válida;
- qué eventos deben emitirse;
- qué auditoría debe registrarse.

---

## 1.2 No usar PATCH genérico para estados críticos

Ejemplo incorrecto:

PATCH /operations/:id
{
  "status": "COMPLETED"
}

Ejemplo correcto:

POST /operations/:id/complete

o una acción de dominio equivalente.

Esto aplica especialmente a:

- Listing;
- Visit;
- Offer;
- Auction;
- Operation;
- Document;
- Contract;
- Signature;
- Payment;
- Verification.

---

## 1.3 Identidad del actor

No aceptar como fuente autoritativa:

- userId;
- ownerId;
- senderId;
- bidderId;
- signerId;
- payerId;
- fromUserId.

La identidad se obtiene de la sesión.

Los identificadores enviados por frontend representan recursos, no identidad autenticada.

---

## 1.4 Respuestas

Las APIs deben devolver DTOs/proyecciones específicas.

No devolver modelos Prisma completos directamente.

Las respuestas deben controlar:

- privacidad;
- campos públicos/privados;
- permisos;
- contexto;
- datos sensibles.

---

## 1.5 Errores

Semántica base:

- 400: petición inválida;
- 401: no autenticado;
- 403: autenticado sin permiso;
- 404: recurso inexistente o no exponible;
- 409: conflicto de estado/concurrencia;
- 422: validación de negocio cuando proceda;
- 429: rate limit;
- 5xx: error interno/proveedor.

Debe existir formato consistente de error.

No exponer stack traces ni detalles sensibles.

---

# 2. Auth

## POST /auth/register

Responsabilidad:

- crear User;
- validar email;
- almacenar contraseña de forma segura;
- generar proceso de verificación;
- crear sesión cuando la política lo permita.

No aceptar:

- role administrativo;
- verification status;
- privilegios.

Eventos posibles:

- USER_REGISTERED
- EMAIL_VERIFICATION_REQUESTED

---

## POST /auth/login

Responsabilidad:

- autenticar;
- aplicar rate limiting;
- crear sesión segura;
- establecer cookie HttpOnly.

No devolver JWT para copiar/pegar manualmente.

Eventos:

- USER_LOGGED_IN
- LOGIN_FAILED cuando corresponda internamente.

---

## POST /auth/logout

Responsabilidad:

- revocar sesión;
- eliminar cookie.

---

## POST /auth/refresh

Solo si la estrategia de sesión implementada requiere refresh.

Debe ser seguro, rotado y revocable.

---

## GET /auth/session

Devuelve:

- usuario actual;
- capacidades contextuales;
- datos mínimos necesarios para UI.

No devuelve secretos.

---

## POST /auth/forgot-password

Responsabilidad:

- iniciar recuperación;
- responder de forma que no facilite enumeración de emails.

---

## POST /auth/reset-password

Responsabilidad:

- validar token;
- establecer nueva contraseña;
- revocar sesiones cuando corresponda.

---

## POST /auth/verify-email

Verifica email mediante token/proceso autorizado.

Frontend no marca `emailVerifiedAt`.

---

## POST /auth/verify-phone

Cuando esté habilitado.

Resultado debe provenir de flujo autorizado.

---

# 3. Users

## GET /users/me

Devuelve perfil privado propio.

---

## PATCH /users/me

Permite editar solo campos autorizados de perfil.

No permite cambiar:

- status crítico;
- permisos;
- verificaciones;
- roles administrativos.

---

## GET /users/:id/public-profile

Devuelve únicamente proyección pública permitida.

---

# 4. Organizations

## POST /organizations

Crea Organization.

Actor autenticado se convierte en miembro/admin inicial según política.

---

## GET /organizations/:id

Devuelve:

- proyección pública o privada según permisos.

---

## PATCH /organizations/:id

Solo OrganizationAdmin o actor autorizado.

Mass assignment prohibido.

---

## GET /organizations/:id/members

Solo miembros con permisos adecuados.

---

## POST /organizations/:id/members

Añade/invita miembro.

Requiere capability correspondiente.

---

## DELETE /organizations/:id/members/:userId

Revoca membership.

Debe afectar permisos derivados inmediatamente.

Genera auditoría.

---

# 5. Properties

## POST /properties

Crea Property.

Actor se obtiene de sesión.

No aceptar `ownerId` arbitrario sin validación.

En creación directa autorizada, backend puede crear `Property` y `PropertyAuthorization OWNER` para el actor en la misma transacción. En contexto Organization no inferir ownership.

## GET /properties/:id/authorizations

Solo owner/manager autorizado según policy, OrganizationAdmin correspondiente o admin con capability.

## POST /properties/:id/authorizations

Delega capacidad tras validar actor, relación vigente, subject, Organization y tipo. Para v0.4, OWNER autorizado o admin puede conceder MANAGER/PUBLISHER según policy.

## POST /property-authorizations/:id/revoke

Acción explícita con autorización, motivo cuando aplique y auditoría. Revocación afecta permisos futuros sin borrar histórico.

---

## GET /properties/:id

Devuelve proyección según contexto:

- pública;
- owner;
- professional;
- admin.

---

## PATCH /properties/:id

Solo campos editables.

No cambiar ownership mediante este endpoint genérico.

---

## POST /properties/:id/transfer-or-delegate

Solo si se necesita durante implementación P1 para ownership/delegación.

Debe ser acción explícita, auditada y autorizada.

No implementar si no es necesaria para v0.4.

---

# 6. Media

## POST /media/upload-intent

Responsabilidad:

- autenticar;
- autorizar recurso;
- validar tipo/tamaño;
- generar upload autorizado.

---

## POST /media/:id/complete-upload

Confirma upload.

Backend verifica metadata/storage.

---

## DELETE /media/:id

Solo actor autorizado.

No borrar medios críticos ligados a historial si la política no lo permite.

---

# 7. Listings

## POST /listings

Crea Listing asociado a Property.

Debe validar relación con Property.

No acepta publisher arbitrario. Backend deriva contexto de actor, Organization autorizada solicitada y `PropertyAuthorization`. Si se solicita `organizationId`, valida membership activa, capacidad y autorización de Organization sobre Property. `publisherUserId`, `publisherOrganizationId` y `responsibleMemberUserId` no son autoridad de frontend; publisher no se modifica mediante PATCH genérico.

---

## GET /listings/:id

Devuelve proyección pública o privada según permisos.

---

## PATCH /listings/:id

Edita campos no críticos:

- descripción;
- características comerciales;
- datos permitidos.

No permite cambiar estado directamente.

---

## POST /listings/:id/publish

Valida:

- actor;
- estado;
- requisitos;
- integridad mínima.

Transición:

DRAFT/UNDER_REVIEW
→ PUBLISHED cuando corresponda.

Eventos:

- LISTING_PUBLISHED

---

## POST /listings/:id/pause

Transición explícita.

Evento:

- LISTING_PAUSED

---

## POST /listings/:id/resume

Valida estado y requisitos.

Evento:

- LISTING_RESUMED

---

## POST /listings/:id/withdraw

Retira publicación.

Auditar.

---

## POST /listings/:id/close

Cierra cuando regla de negocio lo permita.

No utilizar para cerrar silenciosamente una operación incompleta.

---

## POST /listings/:id/change-price

Body conceptual:

- newPrice;
- currency cuando corresponda.

Backend:

1. valida actor;
2. valida estado;
3. valida precio;
4. registra ListingPriceHistory;
5. actualiza Listing;
6. emite LISTING_PRICE_CHANGED;
7. si baja: LISTING_PRICE_DROPPED;
8. audita.

No modifica Offer existentes.

---

# 8. Search

## GET /search/listings

Filtros conceptuales:

- transactionType;
- rentalMode;
- location;
- bbox;
- polygon;
- multiple areas cuando corresponda;
- minPrice;
- maxPrice;
- rooms;
- bathrooms;
- minArea;
- maxArea;
- propertyType;
- features;
- availability;
- availableFrom;
- availableTo;
- sort;
- page/cursor;
- view.

`view`:

- list;
- map.

Debe compartir la misma lógica de filtros.

No construir motores separados para list y map.

El rango `availableFrom`/`availableTo` se aplica cuando la modalidad lo requiere y devuelve solo Listings o PropertyUnits disponibles durante **todo** el intervalo solicitado.

## GET /listings/:id/availability

Devuelve una proyección autorizada de calendario/rangos disponibles y bloqueados de forma segura, sin revelar identidad de ocupantes ni `operationId` privado.

## POST /listings/:id/availability/block

Solo owner/manager/publisher autorizado. Recibe `startsAt`, `endsAt` y motivo privado opcional; valida rango, autorización y solapamientos, y genera evento/auditoría cuando corresponda.

## POST /availability/:id/unblock

Acción explícita no destructiva para retirar bloqueo manual autorizado. Respeta fuente, actor, estado e historial; no permite retirar un `OCCUPIED` derivado de Operation.

---

# 9. Locations

## GET /locations/search

Autocomplete/búsqueda geográfica.

---

## GET /locations/:id

Devuelve contexto geográfico permitido.

---

## GET /locations/:id/children

Cuando sea necesario para jerarquía territorial.

---

# 10. Intelligence

## GET /intelligence/locations/:locationId

Devuelve:

- métricas estructuradas;
- demanda;
- oferta;
- precios;
- tendencias;
- confidence;
- sample size;
- insights.

---

## GET /intelligence/properties/:propertyId

Devuelve Intelligence de Property.

---

## GET /intelligence/listings/:listingId

Devuelve contexto comercial específico.

---

## GET /intelligence/top-zones

Filtros:

- transactionType;
- rentalMode;
- location scope;
- metric;
- period.

No forzar Top 10 si no existe calidad de datos suficiente.

---

## GET /intelligence/opportunities

Devuelve resultados calculados/materializados.

Opportunity no es atributo estático de Property.

---

## GET /intelligence/matches

Según contexto:

- usuario;
- professional;
- lead;
- listing.

Debe respetar privacidad.

---

## POST /internal/intelligence/recalculate

Endpoint interno/no público.

Protegido para worker/admin/service.

No accesible a usuario normal.

---

# 11. Favorites

## GET /favorites

Solo propios.

---

## POST /favorites/:listingId

Idempotente.

Si ya existe, no duplica.

Evento:

- FAVORITE_ADDED

---

## DELETE /favorites/:listingId

Idempotente cuando sea razonable.

Evento:

- FAVORITE_REMOVED

---

# 12. Saved Searches

## GET /saved-searches

Solo propios.

---

## POST /saved-searches

Crea criterios validados.

---

## PATCH /saved-searches/:id

Solo owner.

---

## DELETE /saved-searches/:id

Solo owner.

---

# 13. Conversations

## POST /conversations

Crea conversación contextual.

Debe validar relación legítima con Listing/Operation.

Evitar duplicados cuando corresponda.

---

## GET /conversations

Lista solo las conversaciones autorizadas.

---

## GET /conversations/:id

Valida membership.

---

## POST /conversations/:id/messages

Sender se obtiene de sesión.

Evento:

- MESSAGE_SENT

---

# 14. Visits

## GET /visits

Devuelve solo visitas donde actor tenga relación autorizada.

Nunca todas las visitas del sistema.

---

## GET /visits/:id

Control por recurso.

---

## POST /visits

Body conceptual:

- listingId;
- requested slot;
- optional message.

Backend determina requestedBy.

Valida:

- Listing;
- disponibilidad;
- conflictos;
- permisos.

Evento:

- VISIT_REQUESTED

---

## POST /visits/:id/confirm

Solo host/professional autorizado.

Evento:

- VISIT_CONFIRMED

Genera recordatorio mediante eventos/jobs.

---

## POST /visits/:id/cancel

Actor autorizado.

Requiere motivo cuando corresponda.

Evento:

- VISIT_CANCELLED

---

## POST /visits/:id/complete

Solo actor autorizado.

Evento:

- VISIT_COMPLETED

---

## POST /visits/:id/no-show

Solo actor autorizado.

Evento:

- VISIT_NO_SHOW

---

# 15. Offers

## GET /offers

Devuelve ofertas autorizadas según contexto.

---

## GET /offers/:id

Control por recurso.

---

## POST /offers

Body conceptual:

- listingId;
- amount;
- currency;
- conditions;
- expiresAt cuando esté permitido.

Actor se obtiene de sesión.

Evento:

- OFFER_CREATED

---

## POST /offers/:id/send

Si DRAFT se utiliza en implementación.

Transición explícita.

---

## POST /offers/:id/revise

Crea OfferRevision.

No sobrescribe histórico.

Evento:

- OFFER_REVISED

---

## POST /offers/:id/accept

Acción crítica.

Debe usar:

- transacción;
- autorización;
- validación de estado;
- validación de Listing;
- protección de concurrencia;
- idempotencia cuando corresponda.

Dentro de la transacción:

1. validar Offer;
2. validar Listing;
3. aceptar Offer;
4. crear Operation;
5. cerrar/inutilizar ofertas incompatibles según reglas;
6. actualizar Listing;
7. crear outbox events;
8. commit.

La Operation creada fija `createdVia=OFFER`, `sourceOfferId` de esa Offer y participants derivados por backend. No acepta source, createdVia ni lista de participantes del cliente. No existe `POST /operations` público: las Operations transaccionales nacen de aceptación de Offer o validación de ganador de Auction.

Eventos:

- OFFER_ACCEPTED
- OPERATION_CREATED

Si falla Operation:

no dejar Offer aceptada parcialmente.

---

## POST /offers/:id/reject

Evento:

- OFFER_REJECTED

---

## POST /offers/:id/withdraw

Solo creador autorizado.

Evento:

- OFFER_WITHDRAWN

---

# 16. Auctions

## POST /auctions

Solo publisher/owner/professional autorizado.

---

## GET /auctions/:id

Proyección según permisos.

---

## POST /auctions/:id/start

Valida ventana temporal/estado.

Evento:

- AUCTION_STARTED

---

## POST /auctions/:id/cancel

Acción auditada.

Evento:

- AUCTION_CANCELLED

---

## POST /auctions/:id/bids

Actor = sesión.

Validaciones:

- Auction ACTIVE;
- current time < endsAt;
- importe válido;
- requisitos;
- idempotencia/concurrencia.

Evento:

- BID_PLACED

No exponer bidderId públicamente.

---

## GET /auctions/:id/bids

Respuesta depende de actor:

### Público
- información agregada/permitida.

### Bidder
- sus propias bids.

### Owner/professional/admin
- información autorizada.

---

## POST /internal/auctions/:id/end

Interno/worker.

Transición:

ACTIVE
→ ENDED
→ WINNER_PENDING_VALIDATION

Eventos:

- AUCTION_ENDED
- AUCTION_WINNER_SELECTED cuando corresponda.

---

# 17. Operations

## GET /operations

Devuelve solo Operations autorizadas.

---

## GET /operations/:id

Proyección contextual por participantRole.

---

## GET /operations/:id/requirements

Devuelve Requirements visibles para actor.

Puede incluir proyección:

- completed;
- pending;
- blocked derivado;
- next actions.

---

## POST /operations/:id/cancel

Acción crítica.

Valida:

- actor;
- estado;
- reglas de cancelación;
- consecuencias;
- Listing;
- tareas;
- pagos/firmas existentes.

Requiere motivo.

Evento:

- OPERATION_CANCELLED

No borra nada.

---

## POST /operations/:id/complete

Preferiblemente invocado por dominio/backend cuando todos los requisitos se satisfacen.

No debe ser botón libre del frontend.

Valida:

- Contract;
- Signatures;
- Payment;
- Requirements;
- estado.

Evento:

- OPERATION_COMPLETED

---

## GET /operations/:id/history

Devuelve historial autorizado:

- estados;
- eventos relevantes;
- contratos;
- pagos permitidos;
- documentos permitidos;
- participantes relevantes.

No expone AuditEvent interno completo salvo admin.

---

# 18. Requirements

## GET /operations/:id/requirements

Principal endpoint de lectura.

---

## POST /requirements/:id/waive

Solo actor administrativo/profesional explícitamente autorizado.

Requiere:

- motivo;
- auditoría.

No habilitar para cualquier Requirement.

---

## POST /requirements/:id/retry

Cuando el tipo permita reintento.

El backend decide la transición.

---

# 19. Documents

## POST /documents/upload-intent

Body conceptual:

- documentType;
- related resource;
- metadata mínima.

Backend:

- valida actor;
- permisos;
- necesidad;
- tipo;
- tamaño;
- MIME;
- genera autorización de upload.

---

## POST /documents/:id/complete-upload

Verifica existencia real del objeto.

No aceptar simplemente “uploaded = true”.

---

## POST /documents/:id/submit

UPLOADED
→ UNDER_REVIEW

Evento:

- DOCUMENT_SUBMITTED

---

## POST /documents/:id/validate

Solo reviewer/provider autorizado.

Evento:

- DOCUMENT_VALIDATED

Puede completar Requirement.

---

## POST /documents/:id/reject

Body:

- reason.

Evento:

- DOCUMENT_REJECTED

Puede crear Task/Requirement pendiente.

---

## GET /documents/:id

Devuelve metadata autorizada.

No devuelve URL pública permanente.

---

## POST /documents/:id/download-intent

Valida:

- relación;
- propósito;
- policy;
- estado.

Genera acceso temporal.

Puede crear AuditEvent de acceso sensible.

Debe reautorizar actor, Organization context, purpose, status y expiración de owner/grant/policy; participación en Operation no basta.

## GET /documents/:id/access-grants

Solo actores autorizados; no público.

## POST /documents/:id/access-grants

Crea grant tras validar actor, subject, purpose, duración y policy.

## POST /document-access-grants/:id/revoke

Revoca explícitamente con autorización, motivo cuando corresponda y auditoría; no borra el grant.

---

# 20. Verification

## POST /verifications

Inicia verificación permitida.

Body conceptual:

- subjectType;
- subjectId;
- verificationType.

Debe comprobar relación con subject.

---

## GET /verifications/:id

Devuelve proyección autorizada.

---

## POST /internal/verifications/:id/result

Interno/provider/webhook.

No accesible a usuario normal.

Actualiza estado.

Eventos:

- VERIFICATION_COMPLETED
- VERIFICATION_FAILED

---

# 21. Trust

## GET /trust/users/:id

Devuelve proyección pública segura.

---

## GET /trust/properties/:id

Devuelve evidencias públicas permitidas.

---

## GET /trust/organizations/:id

Proyección pública/profesional.

No devolver:

- pesos internos;
- incidencias sensibles;
- fraude;
- documentos.

---

# 22. Contracts

## POST /operations/:id/contracts

Genera Contract cuando Requirements lo permiten.

No aceptar creación arbitraria fuera de Operation válida.

Evento:

- CONTRACT_CREATED

---

## GET /contracts/:id

Control por participante/permiso.

---

## POST /contracts/:id/send-for-signature

Valida:

- Contract;
- Operation;
- signers;
- estado.

Crea Signature requeridas.

Evento:

- CONTRACT_SENT_FOR_SIGNATURE

---

## GET /contracts/:id/download

Preferiblemente mediante acceso temporal autorizado.

No URL pública permanente.

---

# 23. Signatures

## POST /contracts/:id/signature-session

Solo signer correspondiente.

Crea/obtiene sesión segura del SignatureProvider.

No permite indicar signerId arbitrario.

---

## GET /signatures/:id

Solo signer/participante autorizado.

---

## POST /webhooks/signatures/:provider

Sin sesión de usuario.

Debe:

1. verificar firma criptográfica;
2. validar replay/timestamp cuando proveedor lo permita;
3. aplicar idempotencia;
4. resolver provider reference;
5. actualizar Signature;
6. actualizar Contract si procede;
7. actualizar Operation si procede;
8. generar eventos;
9. auditar.

Eventos:

- SIGNATURE_CONFIRMED
- SIGNATURE_FAILED
- CONTRACT_SIGNED

---

# 24. Payments

## POST /operations/:id/payments

Inicia Payment permitido.

El backend calcula/valida:

- payer;
- amount;
- currency;
- concept;
- commission context.

Cliente no controla importe final.

Debe soportar Idempotency-Key.

Evento:

- PAYMENT_CREATED

---

## GET /payments/:id

Control por recurso.

No exponer datos sensibles.

---

## POST /payments/:id/retry

Es alias UX de crear un nuevo PaymentAttempt, sin revivir un Attempt FAILED. La creación usa Idempotency-Key y el webhook localiza primero Attempt, después reevalúa Payment, Commission y Operation.

Solo si estado lo permite.

No crear doble cobro.

---

## POST /webhooks/payments/:provider

Debe:

1. verificar firma del webhook;
2. deduplicar `providerEventId`;
3. localizar `PaymentAttempt` por `providerReference` o contexto seguro;
4. validar la transición de `PaymentAttempt`;
5. actualizar `PaymentAttempt`;
6. reevaluar `Payment`;
7. reevaluar `Commission`;
8. reevaluar `Operation`;
9. persistir outbox y auditoría.

El webhook no confirma ni falla `Payment` directamente saltándose `PaymentAttempt`.

Eventos:

- PAYMENT_CONFIRMED
- PAYMENT_ATTEMPT_FAILED
- PAYMENT_REFUNDED

No confiar en redirect del navegador como confirmación.

---

# 25. Commissions

## GET /operations/:id/commission

Solo actores autorizados.

Devuelve desglose permitido.

---

## POST /internal/commissions/recalculate

Solo servicio/admin autorizado cuando sea realmente necesario.

No accesible a cliente normal.

Rate y amount nunca vienen autoritativamente del frontend.

---

# 26. Notifications

## GET /notifications

Solo propias.

Soporta:

- unread;
- pagination/cursor.

---

## POST /notifications/:id/read

Solo destinatario.

---

## POST /notifications/read-all

Solo propias.

Leer Notification no completa Task.

---

# 27. Tasks

## GET /tasks

Solo tasks autorizadas.

Filtros:

- open;
- operation;
- due.

---

## POST /tasks/:id/complete

Solo si Task permite completion manual.

Si depende de Requirement real:

rechazar si Requirement no está satisfecha.

---

# 28. Activity

## GET /activity

Devuelve timeline seguro del usuario.

Puede combinar proyecciones de:

- price drops;
- visits;
- offers;
- documents;
- contracts;
- payments;
- operations.

No devuelve DomainEvent bruto.

---

# 29. CRM

## GET /crm/dashboard

Contexto Organization.

Devuelve:

- leads;
- visits;
- offers;
- operations;
- portfolio metrics;
- demand/match summaries.

---

## GET /crm/leads

Solo Organization autorizada.

---

## POST /crm/leads

Puede crear Lead cuando exista caso legítimo.

Evitar duplicar User.

---

## GET /crm/leads/:id

Organization boundary obligatoria.

---

## PATCH /crm/leads/:id

Solo campos CRM permitidos:

- status;
- assignment;
- metadata comercial aprobada.

---

## POST /crm/leads/:id/notes

Crea CRMNote.

---

## POST /crm/leads/:id/tasks

Preferentemente crea Task con contexto profesional.

No crear CRMTask separada salvo necesidad P1.

---

# 30. Owner Analytics

## GET /owner/listings/:id/analytics

Solo owner/manager autorizado.

Devuelve agregados:

- views;
- favorites;
- contacts;
- visits;
- offers;
- trend.

No devuelve identidades de viewers/favorites.

---

# 31. Professional Intelligence / Match

## GET /professional/demand

Solo Organization autorizada.

Devuelve agregados.

---

## GET /professional/matches

Puede devolver:

- leads propios ↔ listings;
- listings ↔ demanda agregada.

No exponer usuarios anónimos.

---

# 32. Investor

No necesita dominio API completamente separado.

Puede reutilizar:

- search;
- intelligence;
- favorites;
- locations.

Si existe endpoint específico:

GET /investor/opportunities

debe ser proyección de Intelligence, no duplicar lógica.

---

# 33. Admin

Rutas bajo:

/admin

Ejemplos:

GET /admin/users
GET /admin/listings
GET /admin/verifications
GET /admin/documents
GET /admin/issues
GET /admin/operations
GET /admin/payments
GET /admin/audit

Acciones:

POST /admin/verifications/:id/revoke
POST /admin/listings/:id/moderate
POST /admin/issues/:id/resolve

Todas requieren capability específica.

No usar `admin = allow all`.

---

# 34. Analytics Events

## POST /analytics/events

Solo para eventos apropiados de cliente.

Ejemplos:

- PROPERTY_VIEWED;
- SEARCH_PERFORMED;
- UI interaction permitida.

Validar:

- event type;
- payload;
- size;
- rate.

No aceptar eventos backend críticos desde cliente.

---

# 35. Internal APIs

Rutas `/internal/*`:

- no públicas;
- autenticadas como service/worker;
- no confiables solo por path;
- protegidas por network/auth mechanism apropiado.

Ejemplos:

- intelligence recalculation;
- auction ending;
- verification result;
- commission maintenance.

---

# 36. Pagination

Listados potencialmente grandes deben paginarse.

Preferencia:

- cursor pagination donde aporte estabilidad;
- page/limit cuando sea suficiente.

Aplicar a:

- search;
- messages;
- notifications;
- activity;
- operations;
- leads;
- audit;
- listings.

No devolver colecciones ilimitadas.

---

# 37. Filtering and sorting

Los filtros deben validarse.

No convertir directamente query params arbitrarios a Prisma.

Whitelist explícita de:

- campos;
- operadores;
- ordenación.

Previene:

- queries costosas;
- exposición accidental;
- acoplamiento del API a Prisma.

---

# 38. API Versioning

v0.4 puede comenzar sin complejidad excesiva.

Debe existir estrategia clara para evolución.

Por ejemplo:

- prefijo `/api`;
- versionado cuando exista ruptura contractual.

No introducir versionado complejo si no se necesita todavía.

---

# 39. Idempotency-Key

Obligatorio o soportado en acciones críticas cuando corresponda:

- payment creation;
- webhooks;
- operation creation indirecta;
- signature requests;
- acciones económicas;
- comandos con riesgo de doble ejecución.

Respuesta repetida con misma key y mismo payload debe ser coherente.

Misma key con payload incompatible debe rechazarse.

---

# 40. Request ID

Cada request debe disponer de identificador correlacionable.

Usarlo en:

- logs;
- errores;
- audit;
- debugging;
- providers cuando sea útil.

No exponer información sensible.

---

# 41. Webhook security

Todo webhook debe:

- leer raw body cuando el proveedor lo requiera;
- verificar criptográficamente;
- comprobar secret/key;
- aplicar idempotencia;
- registrar provider event ID;
- prevenir replay cuando sea posible;
- responder correctamente para evitar retries innecesarios.

No aceptar como válida una petición porque “existe un header signature”.

---

# 42. Upload contracts

Uploads deben validar:

- MIME;
- extension cuando corresponda;
- size;
- ownership;
- expected resource;
- storage path;
- expiry de signed URL.

Documentos privados y media pública deben usar políticas diferentes.

---

# 43. Search performance contract

`GET /search/listings` debe:

- utilizar índices;
- evitar N+1;
- devolver proyección reducida;
- soportar list/map;
- no cargar documentación;
- no cargar relaciones no necesarias.

El rendimiento de búsqueda es requisito competitivo.

---

# 44. Map projection

`view=map` debe devolver solo lo necesario:

- listingId;
- coordinates;
- price;
- currency;
- property type/basic marker information;
- minimal preview when necessary.

No devolver fichas completas para miles de markers.

---

# 45. Intelligence contract

Toda respuesta Intelligence debe incluir cuando corresponda:

- result;
- confidence;
- sampleSize;
- methodologyVersion;
- generatedAt;
- demoSynthetic/source indication.

No presentar métricas sintéticas como reales.

---

# 46. Sandbox awareness

Los recursos de sandbox deben poder identificarse internamente.

Ejemplos:

- Payment test;
- Signature mock;
- Verification mock;
- synthetic market data.

La API/UI puede mostrar una señal de entorno demo cuando sea necesario.

Nunca mezclar accidentalmente producción con sandbox.

---

# 47. Rate limiting

Aplicar límites específicos especialmente a:

- login;
- register;
- forgot password;
- verification;
- messages;
- visits;
- offers;
- bids;
- uploads;
- analytics events;
- webhooks según política del provider.

Los límites exactos se configurarán por entorno.

---

# 48. Caching

No cachear indiscriminadamente.

Candidatos:

- Location;
- MarketSnapshot;
- public Intelligence;
- public Listing projections cuando sea seguro.

No cachear de forma insegura:

- operaciones privadas;
- documentos;
- pagos;
- mensajes.

Siempre considerar invalidación.

---

# 49. API y eventos

Una acción HTTP crítica puede generar varios eventos.

Ejemplo:

POST /offers/:id/accept

puede generar:

- OFFER_ACCEPTED;
- OPERATION_CREATED;
- LISTING_RESERVED.

Pero el endpoint no necesita enviar emails directamente.

Emails/notificaciones se procesan mediante handlers.

---

# 50. Criterio de aceptación de cada endpoint crítico

Antes de considerarlo terminado debe existir:

1. happy path;
2. validación DTO;
3. autorización;
4. state validation;
5. negative tests;
6. error handling;
7. audit cuando corresponda;
8. DomainEvent cuando corresponda;
9. idempotencia cuando corresponda;
10. integración test;
11. documentación de contrato.

---

# 51. Endpoints que NO deben existir como shortcuts inseguros

Evitar:

PATCH /operations/:id/status
PATCH /payments/:id/status
PATCH /contracts/:id/status
PATCH /verifications/:id/status
POST /payments/confirm
POST /contracts/:id/mark-signed
POST /documents/:id/mark-validated
POST /users/:id/make-admin

salvo endpoints internos/admin extremadamente controlados y justificados.

---

# 52. Contrato principal del journey usuario

La API debe permitir ejecutar:

register
→ session
→ search
→ listing
→ intelligence
→ favorite
→ visit
→ offer
→ accept
→ operation
→ requirements
→ documents
→ contract
→ signature sandbox
→ payment sandbox
→ completion
→ history

Sin intervención manual en base de datos.

---

# 53. Contrato principal profesional

Debe permitir:

professional session
→ organization
→ portfolio
→ demand
→ match
→ lead
→ conversation
→ visit
→ offer
→ operation

Sin duplicar entidades.

---

# 54. Criterio de cierre

Los contratos API se consideran válidos cuando:

- reflejan el modelo de dominio;
- respetan las máquinas de estado;
- respetan permisos;
- no exponen recursos privados;
- no permiten mass assignment;
- soportan los journeys;
- las acciones críticas son explícitas;
- los webhooks son fiables;
- pagos/firma no dependen de frontend;
- búsqueda/mapa comparten filtros;
- Intelligence es explicable;
- las APIs pueden testearse de extremo a extremo.
