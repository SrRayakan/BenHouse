# BenHouse v0.4 — Máquinas de Estado

## Objetivo

Definir los estados oficiales y las transiciones permitidas de los recursos críticos de BenHouse v0.4.

Este documento debe impedir:

- transiciones imposibles;
- estados incoherentes;
- saltos de pasos críticos;
- cambios de estado arbitrarios desde frontend;
- pérdida de histórico;
- operaciones parciales;
- dobles cierres;
- inconsistencias entre módulos.

Regla general:

Toda transición crítica debe ejecutarse mediante una acción/comando explícito de backend.

No utilizar PATCH genérico para modificar estados críticos.

---

# 1. Principios generales

## 1.1 El estado pertenece al backend

El frontend:

- solicita una acción;
- muestra el resultado;
- adapta la UX.

El backend:

- autentica;
- autoriza;
- valida el estado actual;
- valida requisitos;
- ejecuta la transición;
- persiste;
- genera eventos;
- audita.

---

## 1.2 No todas las consecuencias son estados

Ejemplos:

- un recordatorio no es un estado de Visit;
- una notificación no es un estado de Operation;
- un evento no es un estado;
- una Task no es el estado del recurso que la origina.

Evitar inflar máquinas de estado con conceptos transversales.

---

## 1.3 Eventos importantes no se eliminan

Una transición histórica relevante debe conservar trazabilidad.

No borrar retroactivamente:

- ofertas rechazadas;
- operaciones canceladas;
- documentos rechazados;
- pagos fallidos;
- contratos anteriores;
- pujas;
- auditoría.

---

# 2. Listing

Estados principales:

- DRAFT
- UNDER_REVIEW
- PUBLISHED
- PAUSED
- RESERVED
- IN_OPERATION
- CLOSED
- REJECTED
- WITHDRAWN

## Transiciones

DRAFT
→ UNDER_REVIEW

UNDER_REVIEW
→ PUBLISHED
→ REJECTED

PUBLISHED
→ PAUSED
→ RESERVED
→ IN_OPERATION
→ WITHDRAWN
→ CLOSED

PAUSED
→ PUBLISHED
→ WITHDRAWN
→ CLOSED

RESERVED
→ IN_OPERATION
→ PUBLISHED si la reserva/operación asociada se cancela y el inmueble vuelve al mercado
→ CLOSED

IN_OPERATION
→ CLOSED
→ PUBLISHED si la operación se cancela y el inmueble vuelve al mercado
→ PAUSED si requiere revisión previa

REJECTED
→ DRAFT cuando se corrigen los motivos de rechazo

WITHDRAWN
→ DRAFT o PUBLISHED solo mediante acción explícita autorizada cuando corresponda

CLOSED
→ no reabrir silenciosamente.

Si el inmueble vuelve al mercado, debe existir una acción explícita de reactivación o nueva publicación según el caso.

## Reglas

- Un Listing no puede publicarse sin los requisitos mínimos de publicación.
- Un Listing no puede pasar a CLOSED por simple PATCH.
- Cambiar el precio no cambia automáticamente el estado.
- Cambiar el precio no modifica ofertas existentes.
- Una operación cancelada puede permitir devolver Listing a PUBLISHED.
- El historial anterior se conserva.

---

# 3. Visit

Estados:

- REQUESTED
- CONFIRMED
- COMPLETED
- CANCELLED
- NO_SHOW

## Transiciones

REQUESTED
→ CONFIRMED
→ CANCELLED

CONFIRMED
→ COMPLETED
→ CANCELLED
→ NO_SHOW

COMPLETED
→ estado final

CANCELLED
→ estado final

NO_SHOW
→ estado final

## Reglas

- No existe estado REMINDER.
- Los recordatorios se generan mediante Task/Event/Notification.
- Una visita pasada no puede confirmarse retroactivamente sin acción administrativa auditada.
- No se puede completar una visita cancelada.
- El resultado de la visita puede registrarse después de COMPLETED.
- Una oferta existente no cancela automáticamente visitas ya confirmadas salvo regla explícita de negocio.

---

# 4. Offer

Estados:

- DRAFT
- SENT
- RECEIVED
- UNDER_NEGOTIATION
- ACCEPTED
- REJECTED
- WITHDRAWN
- EXPIRED
- CLOSED

## Transiciones

DRAFT
→ SENT
→ WITHDRAWN

SENT
→ RECEIVED
→ WITHDRAWN
→ EXPIRED

RECEIVED
→ UNDER_NEGOTIATION
→ ACCEPTED
→ REJECTED
→ WITHDRAWN
→ EXPIRED

UNDER_NEGOTIATION
→ ACCEPTED
→ REJECTED
→ WITHDRAWN
→ EXPIRED

ACCEPTED
→ CLOSED cuando Operation correspondiente se crea correctamente

REJECTED
→ CLOSED

WITHDRAWN
→ CLOSED

EXPIRED
→ CLOSED

## Reglas

- Una Offer aceptada no equivale a Operation completada.
- Aceptar Offer debe ser transaccional.
- Antes de ACCEPTED:
  - Listing debe seguir disponible;
  - Offer debe seguir válida;
  - actor debe estar autorizado.
- Al aceptar una Offer se crea Operation.
- Las ofertas incompatibles pueden cerrarse automáticamente según reglas.
- El histórico se conserva.
- No sobrescribir revisiones anteriores.
- Un cambio de Listing.price no modifica Offer.amount.
- expiresAt debe aplicarse de forma consistente.

---

# 5. OfferRevision

No necesita una máquina de estado compleja.

Cada revisión es inmutable una vez creada.

Reglas:

- representa una propuesta histórica;
- no se elimina;
- no se sobrescribe;
- la Offer puede señalar cuál es la revisión vigente;
- una nueva revisión puede provocar UNDER_NEGOTIATION.

---

# 6. Auction

Estados:

- SCHEDULED
- ACTIVE
- ENDED
- WINNER_PENDING_VALIDATION
- WINNER_VALIDATED
- CANCELLED
- CLOSED

## Transiciones

SCHEDULED
→ ACTIVE
→ CANCELLED

ACTIVE
→ ENDED
→ CANCELLED solo bajo condiciones autorizadas y auditadas

ENDED
→ WINNER_PENDING_VALIDATION
→ CLOSED si no existe candidato válido

WINNER_PENDING_VALIDATION
→ WINNER_VALIDATED
→ CLOSED si el candidato falla validación y no se selecciona otro

WINNER_VALIDATED
→ CLOSED después de crear Operation

CANCELLED
→ estado final

## Reglas

- endsAt determina el cierre temporal.
- Un worker puede ejecutar la transición ACTIVE → ENDED.
- Ganador no significa operación completada.
- El candidato debe pasar validaciones.
- Las identidades de pujadores no son públicas.
- No permitir pujas fuera de ACTIVE.
- No permitir pujas después de endsAt.
- La validación de la puja debe ser atómica.

---

# 7. Bid

Estados mínimos:

- VALID
- INVALID
- OUTBID
- WINNING
- SELECTED
- REJECTED

No todas las actualizaciones necesitan persistirse como transición compleja si pueden calcularse de forma fiable.

Reglas:

- una Bid creada no se modifica;
- una nueva puja genera una nueva Bid;
- no sobrescribir importes;
- SELECTED no equivale a Operation completada;
- el sistema debe poder reconstruir el histórico completo.

---

# 8. Document

Estados:

- PENDING
- REQUESTED
- UPLOADED
- UNDER_REVIEW
- VALIDATED
- REJECTED
- EXPIRED
- ARCHIVED

## Transiciones

PENDING
→ REQUESTED
→ UPLOADED

REQUESTED
→ UPLOADED

UPLOADED
→ UNDER_REVIEW

UNDER_REVIEW
→ VALIDATED
→ REJECTED

REJECTED
→ permanece REJECTED; una corrección crea Document V2 independiente en UPLOADED.

VALIDATED
→ EXPIRED cuando aplique
→ ARCHIVED cuando corresponda

EXPIRED
→ REQUESTED cuando se necesite nueva versión

## Reglas

- REJECTED debe conservar motivo.
- No borrar documento rechazado.
- Una nueva versión no debe destruir la anterior.
- No sobrescribir storageKey/artefacto de una versión histórica.
- El acceso depende de permisos.
- Ser participante de Operation no implica acceso total.
- VALIDATED solo puede establecerlo actor/proceso autorizado.
- Un upload correcto no significa validación.

---

# 9. Verification

# 8.1 AvailabilityPeriod

`AvailabilityPeriod` no necesita una máquina compleja. Si se persiste estado, usar únicamente `ACTIVE` y `CANCELLED` o equivalente, sin duplicar `type` (`AVAILABLE`, `BLOCKED`, `OCCUPIED`). Un `OCCUPIED` derivado de Operation solo cambia mediante el workflow de Operation; un `BLOCKED` manual puede retirarse por actor autorizado. La comprobación de solapamiento y adquisición de rango ocurre dentro de la transacción: dos confirmaciones simultáneas para el mismo rango solo pueden producir una ocupación compatible.

Estados:

- PENDING
- IN_PROGRESS
- VERIFIED
- FAILED
- EXPIRED
- REVOKED

## Transiciones

PENDING
→ IN_PROGRESS

IN_PROGRESS
→ VERIFIED
→ FAILED

VERIFIED
→ EXPIRED
→ REVOKED

FAILED
→ PENDING mediante reintento

EXPIRED
→ PENDING mediante nueva verificación

## Reglas

- VERIFIED no puede determinarlo el frontend.
- Provider puede ser mock/sandbox/real.
- BenHouse conserva su estado interno propio.
- REVOKED requiere causa y auditoría.
- No reducir a booleano.

---

# 10. Contract

Estados:

- PREPARATION
- GENERATED
- SENT
- SIGNATURE_PENDING
- PARTIALLY_SIGNED
- SIGNED
- CANCELLED
- SUPERSEDED
- COMPLETED

## Transiciones

PREPARATION
→ GENERATED

GENERATED
→ SENT
→ CANCELLED

SENT
→ SIGNATURE_PENDING
→ CANCELLED

SIGNATURE_PENDING
→ PARTIALLY_SIGNED
→ SIGNED
→ CANCELLED cuando legal/operativamente proceda

PARTIALLY_SIGNED
→ SIGNED
→ CANCELLED cuando corresponda

SIGNED
→ COMPLETED

CANCELLED
→ estado final

SUPERSEDED
→ estado final

## Reglas

- Un Contract puede requerir varias Signature.
- PARTIALLY_SIGNED se utiliza cuando al menos una firma necesaria se ha completado pero faltan otras.
- SIGNED solo cuando todas las firmas requeridas estén confirmadas.
- No confiar en el navegador.
- Un nuevo Contract/version puede marcar anterior como SUPERSEDED.
- No sobrescribir un Contract ya firmado.
- GENERATED requiere requisitos previos satisfechos según Operation.

---

# 11. Signature

Estados:

- PENDING
- REQUESTED
- IN_PROGRESS
- SIGNED
- FAILED
- DECLINED
- EXPIRED
- CANCELLED

## Transiciones

PENDING
→ REQUESTED

REQUESTED
→ IN_PROGRESS
→ SIGNED
→ FAILED
→ DECLINED
→ EXPIRED
→ CANCELLED

IN_PROGRESS
→ SIGNED
→ FAILED
→ DECLINED
→ EXPIRED

FAILED
→ REQUESTED mediante reintento permitido

EXPIRED
→ REQUESTED mediante nueva solicitud cuando proceda

## Reglas

- SIGNED requiere confirmación fiable del SignatureProvider.
- Webhook debe verificarse.
- Un reintento no debe crear firmas duplicadas incoherentes.
- La Signature pertenece a un Contract concreto y versión concreta.

---

# 12. Payment

Payment usa PENDING, IN_PROGRESS, CONFIRMED, CANCELLED, REFUND_PENDING y REFUNDED; fallo de Attempt devuelve/mantiene Payment pagable. PaymentAttempt usa INITIATED, PROCESSING, CONFIRMED, FAILED y CANCELLED; FAILED es final del intento y retry crea uno nuevo.

Payment: PENDING → IN_PROGRESS → CONFIRMED; IN_PROGRESS → PENDING si los Attempts terminan sin confirmación y puede reintentarse; PENDING/IN_PROGRESS → CANCELLED; CONFIRMED → REFUND_PENDING → REFUNDED.

PaymentAttempt: INITIATED → PROCESSING → CONFIRMED; INITIATED/PROCESSING → FAILED o CANCELLED. FAILED, CONFIRMED y CANCELLED son terminales. Retry crea un Attempt nuevo.

## Reglas

- PAYMENT_ATTEMPT_FAILED no cancela Operation: Payment se reevalúa y suele volver a PENDING.
- El usuario debe poder reintentar cuando proceda.
- CONFIRMED requiere confirmación fiable del PaymentProvider.
- El frontend no confirma pagos.
- Webhooks idempotentes.
- No crear doble Payment confirmado por reintentos.
- El importe es autoritativo en backend.
- No usar dinero real en v0.4.

---

# 13. Commission

Estados:

- PENDING
- CALCULATED
- EARNED
- SETTLEMENT_PENDING
- SETTLED
- CANCELLED
- REVERSED

## Reglas

- La comisión no se considera ganada simplemente por crear Operation.
- El trigger exacto debe responder a la regla comercial/contractual configurada.
- v0.4 puede trabajar con comisión del 2% como configuración.
- Si Operation se cancela antes del trigger, Commission puede cancelarse.
- Si existe devolución/reversión posterior, registrar REVERSED cuando corresponda.
- No borrar histórico económico.

---

# 14. Requirement

Estados:

- PENDING
- IN_PROGRESS
- COMPLETED
- FAILED
- WAIVED
- EXPIRED

## Transiciones

PENDING
→ IN_PROGRESS
→ COMPLETED
→ FAILED
→ WAIVED si actor autorizado lo permite

FAILED
→ IN_PROGRESS mediante corrección

COMPLETED
→ EXPIRED cuando el requisito tenga vigencia temporal y corresponda

EXPIRED
→ IN_PROGRESS o PENDING mediante nueva acción

## Reglas

- BLOCKED no necesita ser estado persistente si puede calcularse.
- Una Requirement puede depender de otra.
- COMPLETED solo cuando la condición real esté satisfecha.
- El usuario no puede marcar libremente COMPLETED cuando depende de un recurso externo.
- WAIVED debe quedar auditado.

---

# 15. Task

Estados:

- OPEN
- IN_PROGRESS
- COMPLETED
- CANCELLED
- EXPIRED

## Reglas

- Task representa una acción pendiente.
- Puede completarse automáticamente por un evento.
- Si depende de Requirement real, no permitir completar manualmente sin satisfacerla.
- No confundir Task con Notification.
- Cancelar una operación puede cancelar tareas asociadas que ya no tengan sentido.

---

# 16. Notification

Estados mínimos:

- PENDING
- SENT
- DELIVERED cuando el canal lo soporte
- READ
- FAILED

No necesita una máquina compleja.

Reglas:

- READ solo representa consumo del usuario.
- Marcar como READ no resuelve la Task o Requirement asociada.
- Fallo de email no debe corromper el estado de dominio original.

---

# 17. Issue

Estados:

- OPEN
- UNDER_REVIEW
- RESOLVED
- DISMISSED

## Transiciones

OPEN
→ UNDER_REVIEW
→ RESOLVED
→ DISMISSED

RESOLVED
→ puede reabrirse solo mediante acción auditada si existe justificación

## Reglas

- Issue no bloquea automáticamente Operation salvo reglas explícitas.
- severity y type pueden influir en reglas.
- Intervención administrativa debe auditarse.

---

# 18. Lead

Estados básicos:

- NEW
- CONTACTED
- QUALIFIED
- UNQUALIFIED
- ACTIVE
- CONVERTED
- LOST
- ARCHIVED

No crear pipeline enterprise.

## Reglas

- CONVERTED debe enlazar con actividad real cuando exista.
- Lead puede seguir asociado a User existente.
- No duplicar información de usuario.

---

# 19. Operation

Esta es la máquina de estado más importante.

Estados principales:

- CREATED
- REQUIREMENTS_PENDING
- DOCUMENTS_PENDING
- DOCUMENTS_UNDER_REVIEW
- READY_FOR_CONTRACT
- CONTRACT_PREPARATION
- SIGNATURE_PENDING
- SIGNED
- PAYMENT_PENDING
- PAYMENT_PROCESSING
- PAYMENT_CONFIRMED
- COMPLETED
- CANCELLATION_PENDING
- CANCELLED

## Flujo normal

CREATED
→ REQUIREMENTS_PENDING

REQUIREMENTS_PENDING
→ DOCUMENTS_PENDING cuando existen documentos requeridos
→ READY_FOR_CONTRACT si no existen bloqueos/documentos pendientes

DOCUMENTS_PENDING
→ DOCUMENTS_UNDER_REVIEW

DOCUMENTS_UNDER_REVIEW
→ DOCUMENTS_PENDING si hay rechazos/correcciones
→ READY_FOR_CONTRACT cuando requisitos documentales críticos estén satisfechos

READY_FOR_CONTRACT
→ CONTRACT_PREPARATION

CONTRACT_PREPARATION
→ SIGNATURE_PENDING

SIGNATURE_PENDING
→ SIGNED

SIGNED
→ PAYMENT_PENDING cuando exista Payment requerido
→ PAYMENT_CONFIRMED si el tipo de Operation no requiere pago dentro del flujo demo y las reglas lo permiten

PAYMENT_PENDING
→ PAYMENT_PROCESSING

PAYMENT_PROCESSING
→ PAYMENT_CONFIRMED
→ PAYMENT_PENDING si Payment falla de forma recuperable

PAYMENT_CONFIRMED
→ COMPLETED cuando todos los requisitos finales estén satisfechos

## Cancelación

Cualquier estado cancelable permitido
→ CANCELLATION_PENDING cuando exista proceso previo necesario
→ CANCELLED

O directamente:

estado permitido
→ CANCELLED

cuando la política permita cancelación inmediata.

## Reglas críticas

1. Offer ACCEPTED no significa Operation COMPLETED.
2. PaymentAttempt FAILED no significa Operation CANCELLED.
3. Document REJECTED no significa Operation CANCELLED.
4. Signature FAILED no significa Operation CANCELLED automáticamente.
5. Los errores recuperables mantienen Operation abierta.
6. Cambios materiales del Listing no pueden modificar silenciosamente la Operation.
7. agreedAmount queda congelado dentro de Operation.
8. COMPLETED requiere todos los requisitos críticos satisfechos.
9. CANCELLED conserva motivo e historial.
10. Cancelar Operation puede devolver Listing al mercado mediante transición explícita.
11. Una Operation completada no vuelve a estado anterior mediante flujo normal.
12. Correcciones posteriores se modelan mediante eventos/procesos adicionales, no reescribiendo historia.

---

# 20. Relación Operation ↔ Listing

La creación de Operation fija provenance inmutable y participants derivados. Una Operation no puede existir con OFFER/AUCTION incompatible; transiciones posteriores no cambian `createdVia`, source ni `agreedAmount`.

Al crear Operation válida:

Listing puede pasar:

PUBLISHED
→ RESERVED
→ IN_OPERATION

o directamente:

PUBLISHED
→ IN_OPERATION

según tipo de proceso.

Al completar Operation:

Listing
→ CLOSED

Al cancelar Operation:

Listing puede:

→ PUBLISHED
→ PAUSED
→ CLOSED

según decisión autorizada.

Nunca reactivar automáticamente sin evaluar el contexto.

---

# 21. Relación Offer ↔ Operation

Flujo:

Offer ACCEPTED
→ transacción
→ Operation CREATED
→ Offer CLOSED

Si falla la creación de Operation:

la transición de Offer no debe quedar parcialmente consolidada.

Debe existir atomicidad.

---

# 22. Relación Auction ↔ Operation

Flujo:

Auction ENDED
→ WINNER_PENDING_VALIDATION
→ WINNER_VALIDATED
→ Operation CREATED
→ Auction CLOSED

Si candidato ganador falla:

- seleccionar siguiente candidato si las reglas lo permiten;
- o cerrar Auction sin Operation.

No marcar Listing como vendido solo porque Auction terminó.

---

# 23. Relación Contract ↔ Operation

Operation READY_FOR_CONTRACT
→ Contract PREPARATION/GENERATED

Operation SIGNATURE_PENDING
depende de Contract y Signature.

Operation SIGNED
solo cuando el Contract requerido esté realmente SIGNED.

No permitir que Operation avance porque el frontend diga que el usuario “terminó”.

---

# 24. Relación Payment ↔ Operation

Operation PAYMENT_PENDING
→ Payment creado/iniciado

PaymentAttempt PROCESSING
→ Operation PAYMENT_PROCESSING

Payment CONFIRMED
→ Operation PAYMENT_CONFIRMED cuando todas las condiciones aplicables se cumplen.

PaymentAttempt FAILED
→ Operation vuelve/mantiene PAYMENT_PENDING.

No cancelar automáticamente.

---

# 25. Reentrada al mercado

Caso:

Operation CANCELLED
→ Listing puede reactivarse.

Reglas:

- ofertas antiguas permanecen cerradas;
- historial de Operation permanece;
- favoritos permanecen;
- SavedSearch permanece;
- usuarios interesados pueden recibir nueva actividad/alerta cuando corresponda;
- no reabrir automáticamente Offer anterior;
- el nuevo estado comercial debe ser coherente con Listing.

---

# 26. Cambios de precio con ofertas activas

Caso:

Listing price = 300.000 €
Offer = 280.000 €
Listing cambia a 290.000 €

Resultado:

- ListingPriceHistory registra el cambio;
- Offer permanece en 280.000 €;
- Offer no se recalcula;
- usuarios con Favorite pueden recibir PRICE_DROPPED;
- Intelligence puede recalcularse;
- negociación existente conserva historia.

Regla obligatoria.

---

# 27. Varias ofertas simultáneas

Se permiten varias Offer activas sobre un Listing mientras las reglas comerciales lo permitan.

Al aceptar una:

- ejecutar transacción;
- validar Listing;
- aceptar Offer elegida;
- crear Operation;
- cerrar o invalidar ofertas incompatibles;
- conservar histórico.

Proteger contra dos accepts simultáneos.

---

# 28. Concurrencia

Casos críticos que deben tener protección:

- dos ofertas aceptadas al mismo tiempo;
- dos bids simultáneas conflictivas;
- dos payments creados por doble clic;
- webhook repetido;
- dos operaciones creadas para el mismo resultado;
- cierre de Auction concurrente con nueva Bid;
- dos cambios incompatibles de Listing.

Utilizar:

- transacciones;
- locks/estrategias de concurrencia cuando corresponda;
- uniques;
- idempotency keys;
- validación de estado dentro de la transacción.

---

# 29. Expiraciones

Recursos que pueden utilizar `expiresAt`:

- Offer;
- Signature request;
- Verification;
- Requirement;
- Task;
- accesos temporales;
- enlaces autorizados.

Un worker puede procesar expiraciones.

No inventar duraciones arbitrarias si no están definidas.

Las duraciones deben ser configuración/regla explícita.

---

# 30. Estado derivado vs persistido

No persistir un estado si se puede derivar de forma fiable y su persistencia introduce inconsistencia.

Ejemplos potenciales:

- “BLOCKED” en Requirement;
- “usuario tiene pendientes”;
- “operación tiene 2 pasos restantes”;
- “esta propiedad es oportunidad”;
- “Bid está actualmente ganando” cuando se puede calcular.

Persistir cuando:

- sea necesario para histórico;
- rendimiento;
- integración;
- consistencia;
- proceso asíncrono.

---

# 31. Reglas de transición

Todas las máquinas críticas deben implementar reglas de transición explícitas.

Un comando debe fallar si:

- estado origen no permite transición;
- actor no tiene permiso;
- recurso no existe;
- requisito previo falta;
- transición produce conflicto;
- idempotency key ya fue procesada de forma incompatible.

Errores deben ser controlados y consistentes.

---

# 32. Auditoría

Transiciones críticas deben generar AuditEvent.

Mínimo:

- actor;
- recurso;
- estado anterior;
- estado nuevo;
- acción;
- timestamp;
- requestId cuando exista.

No todas las lecturas necesitan audit trail.

Accesos a documentación sensible pueden requerir auditoría específica.

---

# 33. Eventos de dominio

Una transición puede generar DomainEvents.

Ejemplos:

LISTING_PUBLISHED
LISTING_PRICE_CHANGED
LISTING_PRICE_DROPPED

VISIT_REQUESTED
VISIT_CONFIRMED
VISIT_COMPLETED
VISIT_CANCELLED

OFFER_CREATED
OFFER_REVISED
OFFER_ACCEPTED
OFFER_REJECTED
OFFER_EXPIRED

AUCTION_STARTED
BID_PLACED
AUCTION_ENDED
AUCTION_WINNER_SELECTED

OPERATION_CREATED
OPERATION_CANCELLED
OPERATION_COMPLETED

DOCUMENT_UPLOADED
DOCUMENT_VALIDATED
DOCUMENT_REJECTED

VERIFICATION_COMPLETED
VERIFICATION_FAILED

CONTRACT_CREATED
CONTRACT_SENT
CONTRACT_SIGNED

PAYMENT_STARTED
PAYMENT_CONFIRMED
PAYMENT_ATTEMPT_FAILED
PAYMENT_REFUNDED

TRUST_EVIDENCE_ADDED

No utilizar eventos para sustituir el estado principal del agregado.

---

# 34. Fallos externos

Si un Provider falla temporalmente:

### EmailProvider
No revertir una operación válida porque falló email.

### AIProvider
No bloquear función crítica.

### PaymentProvider
Mantener Payment/Operation en estado recuperable.

### SignatureProvider
Mantener Signature/Operation pendiente o fallida recuperable.

### IdentityProvider
Mantener Verification pendiente/fallida según respuesta.

### StorageProvider
Si el upload no se completó, no marcar Document como UPLOADED.

---

# 35. Acciones administrativas

Admin puede intervenir en casos aprobados, pero:

- debe tener permisos específicos;
- acción auditada;
- motivo cuando corresponda;
- no puede reescribir histórico;
- no puede firmar automáticamente por otra parte;
- no puede simular pago confirmado sin flujo autorizado;
- no puede saltar restricciones jurídicas/económicas arbitrariamente.

---

# 36. Pruebas obligatorias de máquinas de estado

Para cada máquina crítica probar:

1. transición válida;
2. transición inválida;
3. actor autorizado;
4. actor no autorizado;
5. recurso inexistente;
6. transición repetida;
7. concurrencia cuando proceda;
8. evento generado;
9. auditoría;
10. rollback si falla parte de transacción.

Especialmente:

- Offer;
- Auction;
- Operation;
- Contract;
- Signature;
- Payment;
- Document.

---

# 37. Invariantes obligatorias

Estas reglas no deben romperse:

## Invariante 1
Un cambio de Listing no modifica retrospectivamente una Offer.

## Invariante 2
Offer ACCEPTED ≠ Operation COMPLETED.

## Invariante 3
Errores recuperables no cancelan automáticamente Operation.

## Invariante 4
Eventos importantes no se eliminan.

## Invariante 5
Transiciones críticas son atómicas.

## Invariante 6
Frontend no controla estados críticos.

## Invariante 7
Provider externo no sustituye la semántica interna de BenHouse.

## Invariante 8
Listing, Offer y Operation conservan sus propios contextos históricos.

## Invariante 9
Payment CONFIRMED requiere fuente fiable.

## Invariante 10
Contract SIGNED requiere todas las firmas necesarias confirmadas.

---

# 38. Stress test conceptual

El modelo debe soportar como mínimo:

### Caso A
Vendedor cambia precio con oferta activa.

Resultado:
oferta permanece intacta.

### Caso B
Dos compradores envían oferta.

Resultado:
ambas pueden coexistir.

### Caso C
Propietario intenta aceptar dos simultáneamente.

Resultado:
solo una Operation compatible puede crearse.

### Caso D
Documento rechazado.

Resultado:
Operation queda pendiente, no cancelada.

### Caso E
Pago falla.

Resultado:
PaymentAttempt FAILED y Operation recuperable.

### Caso F
Firma falla.

Resultado:
Signature recuperable, Operation no completada.

### Caso G
Operation cancelada.

Resultado:
historial permanece y Listing puede volver al mercado.

### Caso H
Puja termina.

Resultado:
candidato ganador pasa validación antes de Operation.

### Caso I
Usuario abandona navegador.

Resultado:
worker sigue ejecutando recordatorios/expiraciones/eventos.

### Caso J
Webhook se recibe dos veces.

Resultado:
procesamiento idempotente.

---

# 39. Criterio de cierre

Las máquinas de estado se consideran válidas cuando:

- no existen saltos críticos no controlados;
- todos los caminos felices tienen salida;
- errores recuperables tienen recuperación;
- cancelación mantiene integridad;
- concurrencia crítica está contemplada;
- histórico se preserva;
- eventos y auditoría están definidos;
- estados derivados no se persisten innecesariamente;
- Operation puede recorrer todo el journey aprobado;
- ningún módulo puede modificar arbitrariamente estados de otro.
