# BenHouse v0.4 — Eventos, Outbox y Procesamiento Asíncrono

## Objetivo

Definir cómo BenHouse v0.4 representa, persiste y procesa acontecimientos de dominio sin acoplar innecesariamente sus módulos.

Este documento debe impedir:

- lógica secundaria ejecutada directamente dentro de controllers;
- pérdida de eventos después de cambios de base de datos;
- duplicación de notificaciones;
- webhooks procesados varias veces;
- acoplamiento entre módulos;
- inconsistencia entre Operation, Activity, Task, Notification, Analytics y Audit;
- introducir infraestructura distribuida prematuramente.

BenHouse v0.4 utilizará eventos de dominio + transactional outbox + worker.

No utilizar Kafka en v0.4.

---

# 1. Principio general

Un cambio de dominio puede generar uno o varios acontecimientos.

Flujo conceptual:

ACCIÓN
→ VALIDACIÓN
→ TRANSICIÓN DE DOMINIO
→ PERSISTENCIA
→ OUTBOX EVENT
→ COMMIT
→ WORKER
→ HANDLERS
→ EFECTOS SECUNDARIOS

Ejemplos de efectos secundarios:

- Notification;
- Task;
- Email;
- Analytics;
- TrustEvidence;
- recalculo de Intelligence;
- actualización de Activity;
- integración externa.

La acción principal y el evento crítico asociado deben persistirse de forma coherente.

---

# 2. Qué es un DomainEvent

Un DomainEvent representa un hecho relevante que ya ocurrió dentro de BenHouse.

Ejemplos:

- LISTING_PUBLISHED
- LISTING_PRICE_CHANGED
- VISIT_CONFIRMED
- OFFER_ACCEPTED
- OPERATION_CREATED
- DOCUMENT_VALIDATED
- CONTRACT_SIGNED
- PAYMENT_CONFIRMED

Un DomainEvent no representa una intención futura.

Debe nombrarse en pasado o como acontecimiento consolidado.

---

# 3. Qué NO es un DomainEvent

No confundir con:

## Command

Intención de ejecutar una acción.

Ejemplo:

`AcceptOffer`

## Task

Algo pendiente que un usuario o sistema debe hacer.

Ejemplo:

`Adjuntar documento`

## Notification

Mensaje entregado al usuario.

Ejemplo:

`Tu documento ha sido validado`

## Activity

Representación UX de acontecimientos relevantes.

## AnalyticsEvent

Evento utilizado para análisis.

## AuditEvent

Registro de trazabilidad/seguridad.

Estos conceptos pueden originarse en el mismo hecho pero no son equivalentes.

---

# 4. Transactional Outbox

Cuando una transición crítica genera un evento, el evento se persistirá en la misma transacción de base de datos.

Ejemplo:

Aceptar Offer:

1. bloquear/validar recursos;
2. Offer → ACCEPTED;
3. crear Operation;
4. actualizar Listing;
5. crear OutboxEvent:
   - OFFER_ACCEPTED
   - OPERATION_CREATED
6. commit.

Si la transacción falla:

- no queda Offer aceptada;
- no queda Operation parcial;
- no quedan eventos falsos.

Si la transacción confirma:

los eventos quedan disponibles para el worker aunque el proceso se reinicie.

---

# 5. OutboxEvent

Campos conceptuales:

- id
- eventType
- aggregateType
- aggregateId
- payload
- occurredAt
- createdAt
- processingStatus
- processingAttempts
- nextAttemptAt
- processedAt
- lastError seguro
- correlationId
- causationId opcional
- version

Estados conceptuales:

- PENDING
- PROCESSING
- PROCESSED
- FAILED_RETRYABLE
- DEAD_LETTER

La representación física concreta puede ajustarse durante implementación.

---

# 6. Aggregate

Cada evento debe indicar el recurso principal al que pertenece.

Ejemplos:

OFFER_ACCEPTED
→ aggregateType = OFFER
→ aggregateId = offerId

OPERATION_CREATED
→ aggregateType = OPERATION
→ aggregateId = operationId

Esto facilita:

- trazabilidad;
- orden;
- debugging;
- replay selectivo cuando sea seguro.

---

# 7. Payload

El payload de un evento debe contener solo los datos necesarios.

No convertir DomainEvent en copia completa de todas las entidades.

Evitar:

- documentos completos;
- contraseñas;
- tokens;
- datos sensibles;
- información de pago sensible;
- metadata KYC innecesaria.

Preferir IDs + datos de contexto mínimos.

---

# 8. Versionado de eventos

Los eventos persistidos pueden sobrevivir a cambios de código.

Por tanto:

cada event type debe poder versionarse cuando exista cambio contractual incompatible.

Ejemplo conceptual:

`eventVersion: 1`

No introducir un sistema complejo de event sourcing.

BenHouse v0.4 NO utiliza Event Sourcing como fuente principal de verdad.

PostgreSQL sigue siendo fuente de verdad del estado actual.

---

# 9. Correlation ID

Un flujo complejo debe poder correlacionarse.

Ejemplo:

OFFER_ACCEPTED
→ OPERATION_CREATED
→ REQUIREMENTS_CREATED
→ NOTIFICATIONS_GENERATED

Todos pueden compartir:

`correlationId`

Esto facilita debugging.

---

# 10. Causation ID

Cuando un evento provoca otro:

el nuevo evento puede almacenar:

`causationId = event anterior`

No es obligatorio para cada evento trivial, pero debe soportarse cuando aporte trazabilidad.

---

# 11. Worker

`apps/worker` procesará eventos y jobs.

Responsabilidades:

- outbox;
- notificaciones;
- emails;
- alertas;
- recordatorios;
- expiraciones;
- pujas;
- Intelligence;
- procesos asíncronos aprobados.

No trasladar al worker validaciones que deben impedir una acción antes de responder al usuario.

---

# 12. Regla síncrono vs asíncrono

## Síncrono

Debe ocurrir antes de confirmar éxito cuando afecta integridad principal.

Ejemplos:

- autorización;
- Offer acceptance;
- creación de Operation;
- comprobación de estado;
- cálculo económico autoritativo;
- persistencia principal;
- creación de OutboxEvent.

## Asíncrono

Puede ocurrir después:

- email;
- notification;
- activity projection;
- analytics;
- recalculo no crítico;
- recordatorio;
- TrustEvidence derivada;
- procesamiento de alertas.

---

# 13. Idempotencia de handlers

Todo handler de evento debe poder ejecutarse más de una vez sin producir corrupción.

Ejemplo:

PAYMENT_CONFIRMED recibido/procesado dos veces:

no debe:

- duplicar Commission;
- completar Operation dos veces;
- enviar cinco tareas;
- generar balances duplicados.

Los handlers deben verificar:

- eventId;
- provider event id;
- estado actual;
- unique constraints;
- idempotency record cuando corresponda.

---

# 14. At-least-once delivery

v0.4 puede asumir entrega al menos una vez.

Eso significa:

un evento puede procesarse más de una vez.

Por tanto:

idempotencia es obligatoria.

No diseñar suponiendo exactly-once delivery distribuida.

---

# 15. Orden de eventos

Cuando el orden sea importante, el handler debe comprobar estado/version.

Ejemplo:

DOCUMENT_UPLOADED
antes de
DOCUMENT_VALIDATED.

No confiar únicamente en tiempo de llegada.

Puede utilizar:

- aggregate version;
- estado actual;
- occurredAt;
- secuencia cuando sea necesaria.

---

# 16. Retry

Errores transitorios deben reintentarse.

Ejemplos:

- EmailProvider caído;
- timeout temporal;
- servicio externo no disponible.

Aplicar:

- retry count;
- backoff;
- nextAttemptAt.

No reintentar indefinidamente errores permanentes.

---

# 17. Dead Letter

Después de superar intentos configurados:

evento/handler puede pasar a:

DEAD_LETTER

Debe ser observable.

No perder silenciosamente.

Admin/operación técnica podrá:

- inspeccionar;
- reintentar;
- resolver.

No construir una consola enterprise para v0.4.

Una vista/admin técnica básica o logs suficientes pueden ser adecuados.

---

# 18. Error classification

Clasificar errores:

## Retryable

- timeout;
- 503 externo;
- fallo temporal de red.

## Permanent

- recurso inválido;
- destinatario inexistente;
- payload incompatible;
- configuración incorrecta persistente.

No reintentar permanent errors sin corrección.

---

# 19. Eventos de Listing

Eventos principales:

- LISTING_CREATED
- LISTING_SUBMITTED_FOR_REVIEW
- LISTING_PUBLISHED
- LISTING_PAUSED
- LISTING_RESUMED
- LISTING_WITHDRAWN
- LISTING_CLOSED
- LISTING_PRICE_CHANGED
- LISTING_PRICE_DROPPED

## LISTING_PRICE_DROPPED

Puede provocar:

- alertas a favoritos;
- Activity;
- Notification;
- Analytics;
- recálculo Intelligence.

No modifica Offer.

---

# 20. Eventos de Favorite

- FAVORITE_ADDED
- FAVORITE_REMOVED

Puede alimentar:

- Analytics;
- DemandSignal;
- owner metrics agregados;
- Intelligence.

No exponer identidad del usuario al owner.

---

# 21. Eventos de SavedSearch

- SAVED_SEARCH_CREATED
- SAVED_SEARCH_UPDATED
- SAVED_SEARCH_DISABLED
- SAVED_SEARCH_MATCH_FOUND

`SAVED_SEARCH_MATCH_FOUND` puede generar notificación/email.

Evitar spam mediante reglas de frecuencia.

---

# 22. Eventos de Visit

- VISIT_REQUESTED
- VISIT_CONFIRMED
- VISIT_CANCELLED
- VISIT_COMPLETED
- VISIT_NO_SHOW

## VISIT_CONFIRMED

Puede provocar:

- crear Task/Reminder;
- Notification;
- Email;
- Calendar projection futura si se integra.

## VISIT_COMPLETED

Puede generar:

- DemandSignal;
- TrustEvidence cuando proceda;
- CRM update;
- Analytics.

---

# 23. Eventos de Message

- CONVERSATION_CREATED
- MESSAGE_SENT

MESSAGE_SENT puede:

- actualizar unread counters;
- Notification;
- Activity.

No enviar contenido sensible completo en evento si no es necesario.

---

# 24. Eventos de Offer

- OFFER_CREATED
- OFFER_SENT
- OFFER_REVISED
- OFFER_ACCEPTED
- OFFER_REJECTED
- OFFER_WITHDRAWN
- OFFER_EXPIRED
- OFFER_CLOSED

## OFFER_ACCEPTED

Consecuencias críticas dentro de transacción:

- Operation creada;
- Listing actualizado;
- otras Offers incompatibles cerradas.

Consecuencias secundarias asíncronas:

- notifications;
- email;
- Activity;
- CRM;
- Analytics.

---

# 25. Eventos de Auction

- AUCTION_CREATED
- AUCTION_STARTED
- BID_PLACED
- AUCTION_ENDED
- AUCTION_WINNER_SELECTED
- AUCTION_WINNER_VALIDATED
- AUCTION_CANCELLED
- AUCTION_CLOSED

`BID_PLACED` puede actualizar vistas en tiempo real en futuro.

v0.4 no requiere infraestructura realtime compleja si polling/refetch controlado es suficiente.

No ampliar alcance por realtime.

---

# 26. Eventos de Operation

Eventos:

- OPERATION_CREATED
- OPERATION_STATE_CHANGED cuando sea necesario genéricamente
- OPERATION_REQUIREMENTS_UPDATED
- OPERATION_READY_FOR_CONTRACT
- OPERATION_SIGNED
- OPERATION_PAYMENT_CONFIRMED
- OPERATION_COMPLETED
- OPERATION_CANCELLED

Preferir eventos semánticos concretos para hechos importantes.

Evitar depender únicamente de:

`OPERATION_STATE_CHANGED`

para toda la lógica.

---

# 27. OPERATION_CREATED

El evento incluye solo `operationId`, `listingId`, `createdVia`, sourceOfferId o sourceAuctionId, tipo y participant IDs mínimos necesarios. La creación se audita con actor/origen, fuente, participantes, importe acordado, timestamp y requestId/correlationId.

Puede provocar:

- crear Requirements;
- crear Tasks;
- crear Activity;
- notificaciones a participantes;
- CRM update;
- Analytics;
- Listing update ya realizado en transacción si corresponde.

Requirements críticos necesarios para crear un estado coherente pueden generarse síncronamente si forman parte de la creación de Operation.

---

# 28. Eventos de Requirement

- REQUIREMENT_CREATED
- REQUIREMENT_STARTED
- REQUIREMENT_COMPLETED
- REQUIREMENT_FAILED
- REQUIREMENT_EXPIRED
- REQUIREMENT_WAIVED

`REQUIREMENT_COMPLETED` puede activar evaluación de Operation:

¿todos los Requirements necesarios están completos?

Si sí:

avanzar mediante servicio de dominio a siguiente estado válido.

No cambiar Operation directamente desde handler sin pasar por reglas de dominio.

---

# 29. Eventos de Document

Los eventos documentales incluyen, cuando sea útil, `documentId`, `documentFamilyId`, versión, `operationId` y `requirementId`, sin contenido sensible. DOCUMENT_ACCESS_GRANTED y DOCUMENT_ACCESS_REVOKED solo se emiten cuando requieran handlers o auditoría.

- DOCUMENT_REQUESTED
- DOCUMENT_UPLOADED
- DOCUMENT_SUBMITTED
- DOCUMENT_VALIDATED
- DOCUMENT_REJECTED
- DOCUMENT_EXPIRED
- DOCUMENT_ARCHIVED

## DOCUMENT_VALIDATED

Puede:

- completar Requirement;
- actualizar Task;
- Notification;
- Activity;
- reevaluar Operation.

## DOCUMENT_REJECTED

Puede:

- mantener Requirement pendiente;
- crear Task de corrección;
- Notification;
- Activity.

No cancelar Operation automáticamente.

---

# 30. Eventos de Verification

- VERIFICATION_STARTED
- VERIFICATION_COMPLETED
- VERIFICATION_FAILED
- VERIFICATION_EXPIRED
- VERIFICATION_REVOKED

## VERIFICATION_COMPLETED

Puede:

- completar Requirement;
- generar TrustEvidence;
- Notification;
- reevaluar permisos/requisitos.

---

# 31. Eventos de Trust

- TRUST_EVIDENCE_ADDED
- TRUST_EVIDENCE_REVOKED cuando corresponda
- TRUST_SNAPSHOT_RECALCULATED

TrustSnapshot puede recalcularse asíncronamente.

No bloquear acciones críticas esperando un score salvo regla explícita.

---

# 32. Eventos de Contract

- CONTRACT_CREATED
- CONTRACT_GENERATED
- CONTRACT_SENT_FOR_SIGNATURE
- CONTRACT_PARTIALLY_SIGNED
- CONTRACT_SIGNED
- CONTRACT_CANCELLED
- CONTRACT_SUPERSEDED
- CONTRACT_COMPLETED

## CONTRACT_SIGNED

Puede:

- completar Requirement;
- actualizar Operation;
- Activity;
- Notification;
- Analytics.

---

# 33. Eventos de Signature

- SIGNATURE_REQUESTED
- SIGNATURE_STARTED
- SIGNATURE_CONFIRMED
- SIGNATURE_FAILED
- SIGNATURE_DECLINED
- SIGNATURE_EXPIRED

El webhook externo puede originar estos eventos internos después de verificación.

No guardar el evento externo sin validación como evento de dominio confiable.

---

# 34. Eventos de Payment

Separar PAYMENT_* de PAYMENT_ATTEMPT_*; un Attempt fallido deja Payment recuperable y uno confirmado permite confirmar Payment de forma idempotente.

Payment:

- PAYMENT_CREATED
- PAYMENT_IN_PROGRESS
- PAYMENT_CONFIRMED
- PAYMENT_CANCELLED
- PAYMENT_REFUND_STARTED
- PAYMENT_REFUNDED

PaymentAttempt:

- PAYMENT_ATTEMPT_CREATED
- PAYMENT_ATTEMPT_PROCESSING
- PAYMENT_ATTEMPT_CONFIRMED
- PAYMENT_ATTEMPT_FAILED
- PAYMENT_ATTEMPT_CANCELLED

## PAYMENT_CONFIRMED

Puede:

- completar Requirement;
- actualizar Commission;
- reevaluar Operation;
- Notification;
- Activity;
- Analytics;
- Audit.

Debe ser idempotente.

## PAYMENT_ATTEMPT_FAILED

Puede:

- crear Task de reintento;
- Notification;
- Activity.

No cancelar Operation automáticamente.

---

# 35. Eventos de Commission

- COMMISSION_CALCULATED
- COMMISSION_EARNED
- COMMISSION_SETTLEMENT_PENDING
- COMMISSION_SETTLED
- COMMISSION_CANCELLED
- COMMISSION_REVERSED

No exponer estos eventos completos públicamente.

---

# 36. Eventos de CRM

- LEAD_CREATED
- LEAD_ASSIGNED
- LEAD_STATUS_CHANGED
- LEAD_CONVERTED
- CRM_NOTE_CREATED

Muchos cambios CRM pueden ser secundarios a actividad real.

Ejemplo:

VISIT_REQUESTED
→ actualizar Lead relacionado.

No duplicar flujo.

---

# 37. Analytics Events

No todos necesitan transactional outbox.

Diferenciar:

## Backend-critical analytics

Derivados de eventos de dominio fiables.

Ejemplo:

OPERATION_COMPLETED
→ analytics.

## Frontend analytics

Ejemplo:

PROPERTY_VIEWED.

Puede enviarse directamente a endpoint analytics.

No mezclar ambos niveles de confianza.

---

# 38. Activity Projection

Activity debe generarse a partir de eventos relevantes.

Ejemplo:

LISTING_PRICE_DROPPED
→ Activity:
“Una vivienda guardada ha bajado de precio.”

VISIT_CONFIRMED
→ Activity:
“Tu visita está confirmada.”

DOCUMENT_VALIDATED
→ Activity:
“Tu documento ha sido validado.”

Activity payload debe:

- ser seguro;
- estar adaptado al usuario;
- no revelar datos no autorizados.

---

# 39. Notification Handler

Los eventos pueden producir Notification.

Ejemplo:

OFFER_ACCEPTED
→ comprador:
“Tu oferta ha sido aceptada.”

→ owner:
“Has aceptado una oferta.”

Cada usuario recibe proyección distinta del mismo evento.

No utilizar el payload bruto como texto de Notification.

---

# 40. Email Handler

Email se genera desde plantillas.

Nunca enviar directamente desde controllers.

Ejemplos:

- verify email;
- password reset;
- visit confirmation;
- offer updates;
- document status;
- signature request;
- payment status;
- critical operation events.

Un fallo de email no revierte el evento original.

---

# 41. Task Handler

Los eventos pueden crear/cerrar Tasks.

Ejemplo:

OPERATION_CREATED
→ Task: completar identificación.

DOCUMENT_VALIDATED
→ cerrar Task asociada.

DOCUMENT_REJECTED
→ Task: corregir documento.

PAYMENT_ATTEMPT_FAILED
→ Task: reintentar pago.

Evitar duplicar Tasks mediante event id/idempotency.

---

# 42. Reminder Jobs

Los recordatorios pueden derivarse de:

- Visit.scheduledAt;
- Offer.expiresAt;
- Signature expiry;
- Requirement.dueAt;
- Task.dueAt.

No crear estado REMINDER en el agregado.

Ejemplo:

VISIT_CONFIRMED
→ schedule reminder job.

---

# 43. Expiration Jobs

Worker debe poder ejecutar:

- expire Offers;
- expire Signature requests;
- expire Verification;
- expire Tasks/Requirements cuando corresponda;
- close Auctions;
- invalidar accesos temporales cuando sea responsabilidad propia.

La transición debe pasar por servicio de dominio.

No hacer update directo de status desde job.

---

# 44. Auction Ending Job

Proceso:

1. obtener Auction ACTIVE cuyo endsAt <= now;
2. adquirir protección de concurrencia;
3. rechazar nuevas Bid;
4. transición a ENDED;
5. determinar candidato;
6. emitir eventos;
7. iniciar validación.

Debe soportar que el job se ejecute dos veces.

---

# 45. Saved Search Job

Puede ejecutarse periódicamente o reaccionar a LISTING_PUBLISHED.

Debe:

- evaluar criterios;
- deduplicar matches;
- respetar frecuencia;
- no notificar repetidamente el mismo Listing sin razón.

No construir motor de recomendaciones masivo en v0.4.

---

# 46. Intelligence Recalculation

Triggers posibles:

- LISTING_PUBLISHED;
- LISTING_PRICE_CHANGED;
- nueva actividad agregada;
- job periódico;
- cambios en dataset.

No recalcular todo el mercado ante cada vista.

Utilizar estrategia razonable:

- batching;
- snapshots;
- periodicidad;
- eventos relevantes.

---

# 47. DemandSignal

Eventos de comportamiento pueden crear DemandSignal.

Ejemplos:

SEARCH_PERFORMED
FAVORITE_ADDED
VISIT_REQUESTED
MESSAGE_SENT
OFFER_CREATED

Cada tipo puede tener peso/configuración.

Los pesos no deben quedar hardcodeados sin versionado/metodología.

Los datos demo deben marcarse synthetic.

---

# 48. Match Recalculation

Puede dispararse cuando:

- Lead cambia;
- SavedSearch cambia;
- Listing se publica;
- perfil de demanda cambia;
- Intelligence cambia significativamente.

Debe evitar recalcular todo innecesariamente.

v0.4 puede utilizar procesamiento batch simple.

---

# 49. Webhooks externos

Flujo obligatorio:

EXTERNAL WEBHOOK
→ VERIFY SIGNATURE
→ VERIFY EVENT ID
→ IDEMPOTENCY
→ NORMALIZE PROVIDER EVENT
→ APPLICATION SERVICE
→ DOMAIN CHANGE
→ OUTBOX EVENT
→ COMMIT

Nunca:

EXTERNAL WEBHOOK
→ update database status directo sin reglas.

---

# 50. Provider Event Record

Puede existir persistencia técnica para eventos externos cuando aporte valor.

Campos conceptuales:

- provider;
- providerEventId;
- eventType;
- receivedAt;
- processingStatus;
- payload hash;
- processedAt.

No guardar payload sensible completo salvo necesidad.

Su objetivo:

- idempotencia;
- debugging;
- replay seguro.

Puede ser infraestructura, no entidad de dominio central.

---

# 51. Payment Webhook

Ejemplo:

provider says payment succeeded.

BenHouse:

1. verifica webhook;
2. deduplica;
3. localiza Payment;
4. valida estado;
5. confirma Payment;
6. crea PAYMENT_CONFIRMED outbox event;
7. commit;
8. handlers actualizan Operation/Notification/etc.

No usar redirect del navegador.

---

# 52. Signature Webhook

Mismo patrón.

Provider:
signature completed.

BenHouse:

1. verifica;
2. deduplica;
3. localiza Signature;
4. confirma;
5. comprueba otras firmas;
6. actualiza Contract cuando corresponda;
7. outbox;
8. Operation se reevaluará mediante reglas.

---

# 53. Event handler boundaries

Handlers no deben conocerse circularmente entre sí.

Ejemplo incorrecto:

OfferHandler llama directamente a PaymentHandler.

Correcto:

dominio produce eventos y cada módulo reacciona según responsabilidad.

Evitar cascadas infinitas.

---

# 54. Event loops

Debe prevenirse:

EVENT A
→ handler genera EVENT B
→ handler genera EVENT A
→ loop.

Cada evento debe representar cambio real.

No emitir evento si no cambió nada.

Handlers idempotentes.

---

# 55. Replaying

No construir event sourcing.

Pero debe ser posible reintentar de forma controlada eventos fallidos.

Un replay:

- no debe reejecutar efectos económicos irreversibles sin idempotencia;
- debe respetar estado actual;
- debe quedar auditado cuando sea crítico.

---

# 56. Observabilidad

Métricas técnicas mínimas:

- outbox pending count;
- oldest pending age;
- processing latency;
- handler failures;
- retry count;
- dead letters;
- jobs failed;
- webhook verification failures.

Esto permite detectar que el sistema aparentemente funciona pero los procesos asíncronos están detenidos.

---

# 57. Logging

Cada procesamiento debe incluir cuando corresponda:

- eventId;
- eventType;
- aggregateId;
- correlationId;
- handler;
- attempt;
- result;
- duration.

No loggear payload completo automáticamente.

---

# 58. Seguridad

Eventos no saltan permisos.

Ejemplo:

un handler que descarga Document debe actuar con policy interna específica.

El worker no debe tener acceso global innecesario a todos los recursos externos.

Secrets de providers:

- variables seguras;
- no payload;
- no logs.

---

# 59. Transacción vs evento

No mover a asíncrono aquello que sea necesario para mantener invariantes.

Ejemplo:

OFFER_ACCEPTED
y
OPERATION_CREATED

deben poder pertenecer a la misma transacción.

Enviar email:

asíncrono.

Regla:

consistencia primaria primero;
efectos secundarios después.

---

# 60. Tiempo real

v0.4 no requiere infraestructura realtime avanzada.

Cuando sea necesario actualizar UI:

puede utilizarse:

- refetch;
- polling moderado;
- server events/websocket solo si existe necesidad demostrada.

No introducir WebSocket infrastructure únicamente porque existen eventos.

---

# 61. Evento vs AuditEvent

DomainEvent:

“Payment confirmado.”

AuditEvent:

“Webhook del proveedor X provocó transición PaymentAttempt PROCESSING → CONFIRMED.”

Pueden coexistir.

No son duplicados conceptuales.

---

# 62. Evento vs AnalyticsEvent

DomainEvent:

“OFFER_ACCEPTED”

Analytics:

“conversion funnel: offer accepted.”

Analytics puede derivarse del DomainEvent.

No utilizar Analytics como orquestador.

---

# 63. Evento vs Activity

DomainEvent:

`DOCUMENT_VALIDATED`

Activity para usuario:

`Tu documento de identidad ha sido validado.`

Activity es una proyección.

---

# 64. Evento vs Notification

Activity puede permanecer en timeline.

Notification puede tener:

- unread;
- delivery status;
- email/in-app channel.

No asumir que deben ser una misma tabla.

---

# 65. Escenario completo: Price Drop

1. Owner cambia Listing.price.
2. ListingPriceHistory se crea.
3. Outbox:
   - LISTING_PRICE_CHANGED
   - LISTING_PRICE_DROPPED.
4. Commit.
5. Worker procesa.
6. Intelligence recalculation scheduled.
7. Favorite subscribers encontrados.
8. Activity creada.
9. Notification creada.
10. Email según preferencias.
11. Analytics actualizado.

Offer existentes permanecen intactas.

---

# 66. Escenario completo: Offer Accepted

1. request accept.
2. auth.
3. permission.
4. transaction.
5. validate Offer.
6. validate Listing.
7. Offer ACCEPTED.
8. Operation CREATED.
9. Listing RESERVED/IN_OPERATION.
10. otras offers incompatibles cerradas.
11. outbox events.
12. commit.
13. worker:
    - notifications;
    - Tasks;
    - Requirements secundarios;
    - Activity;
    - CRM;
    - Analytics.

No email dentro de la transacción.

---

# 67. Escenario completo: Payment Confirmed

1. PSP envía webhook.
2. verificar firma.
3. deduplicar providerEventId.
4. localizar PaymentAttempt.
5. transacción y validar transición de PaymentAttempt.
6. PaymentAttempt → CONFIRMED.
7. reevaluar Payment.
8. si Payment cambia, emitir el evento Payment correspondiente.
9. reevaluar Commission.
10. reevaluar Operation.
11. persistir outbox y audit; commit.
12. worker procesa handlers idempotentes.
13. Requirement se completa cuando corresponda.
14. si cumple todo:
    Operation → PAYMENT_CONFIRMED/COMPLETED.
15. notifications/activity/analytics.

Idempotente.

---

# 68. Escenario completo: Document Rejected

1. reviewer rechaza.
2. Document → REJECTED.
3. reason persistido.
4. outbox DOCUMENT_REJECTED.
5. commit.
6. handler:
   - Requirement sigue pendiente;
   - Task de corrección;
   - Notification;
   - Activity.
7. Operation permanece abierta.

---

# 69. Escenario completo: Visit Reminder

1. VISIT_CONFIRMED.
2. handler programa job.
3. llega momento.
4. worker valida que Visit sigue CONFIRMED.
5. crea Notification/email.
6. marca reminder job procesado.

Si Visit fue CANCELLED:

no enviar.

---

# 70. Testing

Tests obligatorios:

## Outbox

- evento persiste con transaction;
- rollback elimina cambio + evento;
- worker procesa;
- retry;
- dead letter.

## Idempotencia

- mismo evento dos veces;
- webhook dos veces;
- handler dos veces.

## Ordering

- evento antiguo no corrompe estado nuevo.

## Failure

- EmailProvider falla;
- PaymentProvider timeout;
- worker reinicia;
- evento queda pendiente.

## Security

- payload no filtra secretos;
- internal handlers respetan policies.

---

# 71. No Event Sourcing

Decisión explícita:

BenHouse v0.4 no será event-sourced.

No reconstruir Property/Operation exclusivamente desde eventos.

Estado actual:

PostgreSQL domain tables.

Eventos:

- integración;
- desacoplamiento;
- auditoría parcial;
- efectos secundarios.

Esto reduce complejidad.

---

# 72. No broker distribuido inicial

No utilizar inicialmente:

- Kafka;
- RabbitMQ;
- infraestructura distribuida compleja.

PostgreSQL + outbox + worker es suficiente para v0.4.

Si métricas futuras demuestran necesidad:

se evalúa migración.

---

# 73. Criterio de cierre

La arquitectura de eventos se considera válida cuando:

- los cambios críticos y sus eventos no pueden separarse;
- handlers son idempotentes;
- errores transitorios pueden reintentarse;
- errores permanentes son observables;
- webhooks externos se normalizan;
- Activity/Notification/Task no se confunden con DomainEvent;
- email no bloquea operaciones;
- Intelligence puede reaccionar sin acoplamiento;
- no hay dependencia en Kafka;
- los escenarios críticos sobreviven a reinicios del worker;
- los eventos no exponen datos sensibles.
