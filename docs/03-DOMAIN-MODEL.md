# BenHouse v0.4 — Modelo de Dominio

## Objetivo

Definir las entidades de dominio oficiales de BenHouse v0.4, sus responsabilidades, relaciones principales y límites conceptuales.

Este documento debe impedir:

- duplicidades;
- entidades ambiguas;
- mezclar conceptos diferentes;
- acoplar el dominio a proveedores externos;
- trasladar lógica de negocio a campos arbitrarios;
- reproducir el modelo simplificado del prototipo antiguo.

El modelo debe ser relacional, coherente con PostgreSQL + Prisma y compatible con PostGIS.

No es todavía el schema Prisma final.

Primero se define correctamente el dominio.

---

# 1. Principios generales

## 1.1 Una sola fuente de verdad

Siempre que un concepto ya exista en el dominio, otros módulos deben referenciarlo en lugar de duplicarlo.

Ejemplos:

- el CRM reutiliza `User`, no crea `CRMUser`;
- el CRM reutiliza `Property`, no crea `CRMProperty`;
- analytics observa acontecimientos, no duplica operaciones;
- Activity representa acontecimientos relevantes, no sustituye DomainEvent;
- Trust utiliza evidencias, no duplica Verification.

---

## 1.2 Separar activo, comercialización y operación

Deben existir como conceptos independientes:

`Property`
→ activo inmobiliario real

`Listing`
→ forma en la que se comercializa

`Operation`
→ operación concreta entre participantes

Nunca fusionarlos.

Una propiedad puede:

- existir sin publicación;
- tener publicaciones diferentes a lo largo del tiempo;
- tener operaciones canceladas;
- volver al mercado;
- mantener su historial.

---

# 2. Identidad

## User

Representa una identidad individual dentro de BenHouse.

Responsabilidades:

- autenticación;
- perfil;
- información de contacto;
- verificaciones;
- relaciones;
- participación en operaciones.

Campos conceptuales:

- id
- email
- phone
- name
- avatar
- status
- emailVerifiedAt
- phoneVerifiedAt
- createdAt
- updatedAt

Las credenciales concretas pueden residir en entidades o infraestructura específica de autenticación cuando sea conveniente.

No utilizar un único campo `role` para definir todo el comportamiento del usuario.

Un User puede actuar simultáneamente como:

- comprador;
- inquilino;
- propietario;
- inversor;
- profesional.

---

# 3. Organización profesional

## Organization

Representa una agencia, empresa u organización profesional.

Campos conceptuales:

- id
- name
- legalName
- taxIdentifier cuando corresponda
- contactData
- status
- createdAt
- updatedAt

Puede tener:

- miembros;
- propiedades/publicaciones gestionadas;
- verificaciones;
- operaciones;
- leads;
- actividad.

---

## OrganizationMember

Relación entre User y Organization.

Campos conceptuales:

- organizationId
- userId
- role/capability
- status
- joinedAt

Permisos empresariales de v0.4 deben mantenerse simples.

No construir jerarquía IAM enterprise.

---

# 4. Inmueble

## Property

Representa el activo físico inmobiliario.

No representa una publicación.

Campos conceptuales:

- id
- type
- locationId
- address estructurada cuando corresponda
- latitude/longitude o representación geoespacial
- builtArea
- usableArea
- rooms
- bathrooms
- floor
- constructionYear
- features
- status
- createdAt
- updatedAt

La posición geográfica debe poder utilizar PostGIS.

El precio comercial NO pertenece principalmente a Property.

---

## PropertyUnit

Entidad opcional para representar unidades comercializables dentro de una Property.

Principal uso v0.4:

- habitaciones;
- unidades independientes cuando corresponda.

Campos conceptuales:

- id
- propertyId
- type
- name/identifier
- area
- rooms cuando proceda
- status
- metadata

No crear PropertyUnit automáticamente para cada vivienda.

Solo cuando exista una unidad con significado real.

---

# 5. Ubicación

# 4.1 PropertyAuthorization

Relación autorizada entre `Property` y exactamente un sujeto: `User` **o** `Organization` (nunca ambos ni ninguno). Campos: `id`, `propertyId`, `userId` opcional, `organizationId` opcional, `authorizationType`, `status`, `grantedByUserId` opcional, `validFrom`, `validUntil`, `createdAt`, `updatedAt`, `revokedAt` opcional.

Tipos: `OWNER`, `MANAGER`, `PUBLISHER`; estados: `ACTIVE`, `REVOKED`, `EXPIRED`. Solo autorizaciones activas y vigentes generan permisos. OWNER es la relación reconocida por BenHouse, no un registro jurídico; MANAGER/PUBLISHER no implican ownership. Una Property puede tener varios sujetos autorizados sin introducir copropiedad jurídica.

Ejemplo: User A es OWNER; Organization B es MANAGER y PUBLISHER. B puede actuar sin convertirse en propietaria. Membership por sí sola no concede acceso: requiere membership activa, capability, PropertyAuthorization y policy/assignment aplicable. Crear Property no prueba ownership salvo que el caso autorizado cree `OWNER` en la misma transacción.

## Location

Representa una entidad geográfica estructurada.

Debe permitir jerarquía territorial.

Campos conceptuales:

- id
- country
- autonomousCommunity
- province
- municipality
- district
- neighborhood
- postalCode
- geometry/centroid cuando corresponda
- parentLocationId opcional
- createdAt
- updatedAt

Debe soportar:

- búsquedas;
- Intelligence;
- comparables;
- agregaciones;
- rankings;
- mapa.

No depender exclusivamente de nombres de ciudad en texto libre.

---

# 6. Medios

## Media

Representa un recurso multimedia asociado a una Property o cuando corresponda a una PropertyUnit.

Tipos iniciales:

- IMAGE
- VIDEO
- FLOOR_PLAN

Campos conceptuales:

- id
- propertyId
- propertyUnitId opcional
- type
- storageKey
- order
- metadata
- createdAt

El archivo físico no reside en PostgreSQL.

---

# 7. Publicación

## Listing

Representa una oferta comercial de una propiedad.

Campos conceptuales:

- id
- propertyId
- propertyUnitId opcional
- publisherUserId opcional
- publisherOrganizationId opcional
- responsibleMemberUserId opcional cuando el publisher sea Organization
- transactionType
- rentalMode opcional
- price
- currency
- status
- availableFrom
- availableUntil
- description
- publishedAt
- pausedAt
- closedAt
- createdAt
- updatedAt

`transactionType` inicial:

- SALE
- RENT

`rentalMode` cuando transactionType = RENT:

- LONG_TERM
- SEASONAL
- VACATION
- ROOM

Un Listing tiene exactamente un contexto publisher principal: `publisherUserId` XOR `publisherOrganizationId`. Si publica Organization, `responsibleMemberUserId` puede identificar al profesional activo responsable, sin sustituir a Organization ni convertirse en publisher individual. Publisher no determina owner: debe existir `PropertyAuthorization` vigente del publisher con capacidad suficiente. Revocar MANAGER/PUBLISHER elimina permisos futuros y puede pausar Listing mediante proceso de dominio; no reescribe histórico ni cancela Operations activas.

No crear cuatro arquitecturas de alquiler diferentes.

Compartir infraestructura siempre que las reglas lo permitan.

---

## ListingPriceHistory

Registra cambios de precio.

Campos conceptuales:

- id
- listingId
- oldPrice
- newPrice
- currency
- changedBy
- changedAt

Responsabilidades:

- histórico;
- alertas de bajada;
- Intelligence;
- trazabilidad.

Una bajada de precio puede generar un DomainEvent.

Nunca modificar retrospectivamente una Offer existente cuando cambia el precio del Listing.

---

# 8. Disponibilidad

La disponibilidad debe modelarse de forma compatible con los diferentes modos de alquiler.

No forzar una única semántica temporal.

### LONG_TERM

Conceptos principales:

- availableFrom
- duración/condiciones

### SEASONAL

- rango de fechas;
- restricciones.

### VACATION

Necesita disponibilidad por fechas/calendario.

### ROOM

Puede requerir disponibilidad específica de PropertyUnit.

Si durante diseño físico se necesita una entidad de calendario/disponibilidad específica, podrá introducirse como requisito P1 del dominio ya aprobado, sin ampliar funcionalidad.

No crear cuatro motores independientes.

---

# 9. Favoritos

# 8.1 Disponibilidad temporal

## AvailabilityPeriod

Representa un intervalo temporal relevante para la disponibilidad comercial de un `Listing` o, cuando corresponda, de una `PropertyUnit`. Permite persistir disponibilidad, bloqueos, ocupación derivada de Operation, periodos no comercializables, búsqueda por fechas y prevención de conflictos.

Campos conceptuales: `id`, `listingId`, `propertyUnitId` opcional, `startsAt`, `endsAt`, `type`, `sourceType`, `sourceId` opcional, `status` solo si es necesario, `createdAt` y `updatedAt` cuando corresponda.

Tipos mínimos: `AVAILABLE`, `BLOCKED`, `OCCUPIED`. `sourceType/sourceId` solo aporta trazabilidad (`OPERATION`, `OWNER_BLOCK`, `SYSTEM`); durante el diseño físico se preferirá relación segura para fuentes críticas como Operation.

Los intervalos usan `[startsAt, endsAt)`: inicio incluido y fin excluido. Todas las fechas deben manejar timezone coherente; la decisión física `DATE` frente a `TIMESTAMP` se concreta en el diseño de base de datos.

No pueden coexistir periodos incompatibles de ocupación o bloqueo efectivo sobre el mismo recurso temporal: el Listing completo si no hay `PropertyUnit`, o la unidad concreta cuando la publicación es por unidad. La garantía final se aplica en backend, transacción y restricción PostgreSQL/range/exclusion o mecanismo equivalente.

`AVAILABLE` puede representarse por defecto más excepciones; no exige filas diarias. LONG_TERM usa principalmente `availableFrom` y condiciones, con periodos solo para rangos concretos. SEASONAL usa rangos. VACATION exige disponibilidad completa para todo el rango buscado. ROOM aplica el periodo a la `PropertyUnit` concreta.

Una Operation de alquiler puede generar `OCCUPIED` al alcanzar el punto de compromiso definido por negocio; una Offer aceptada no bloquea definitivamente por sí sola. Al cancelar Operation, su periodo deja de impedir disponibilidad mediante regla explícita y conserva trazabilidad. `Listing.status` y `AvailabilityPeriod` son conceptos distintos: un Listing VACATION puede seguir `PUBLISHED` con días ocupados.

Una Property no puede comercializar simultáneamente vivienda completa y unidades con ocupación temporal incompatible. La publicación/Operation valida ese conflicto; no se introduce un motor de inventario independiente.

## Favorite

Relación User ↔ Listing.

Campos conceptuales:

- userId
- listingId
- createdAt

Restricción:

un usuario no puede guardar dos veces el mismo Listing.

Favorite debe poder mantenerse aunque Listing cambie de estado para conservar el historial del usuario.

---

# 10. Búsqueda guardada

## SavedSearch

Representa criterios persistentes de búsqueda.

Campos conceptuales:

- id
- userId
- name
- criteria
- notificationConfiguration
- status
- createdAt
- updatedAt

Los criterios deben validarse.

Cuando sea necesario por rendimiento, determinados filtros podrán materializarse/indexarse.

No almacenar filtros críticos como JSON completamente opaco si impide consultas eficientes.

---

# 11. Demanda

## DemandSignal

Representa una señal agregable de demanda generada por actividad real o demo etiquetada.

Ejemplos:

- búsqueda;
- favorito;
- contacto;
- visita;
- oferta.

Campos conceptuales:

- id
- userId opcional según privacidad
- listingId opcional
- propertyId opcional
- locationId opcional
- signalType
- weight/version cuando corresponda
- source
- occurredAt
- demoSynthetic

No interpretar una sola búsqueda como “demanda real”.

La demanda se deriva de agregaciones.

---

# 12. Intelligence de mercado

## MarketSnapshot

Snapshot temporal de mercado en una Location.

Campos conceptuales:

- id
- locationId
- transactionType
- propertyType opcional
- rentalMode opcional
- averagePrice
- medianPrice cuando corresponda
- averagePriceM2
- supply
- demandLevel
- sampleSize
- periodStart
- periodEnd
- methodologyVersion
- generatedAt
- demoSynthetic

Debe conservar histórico.

---

## PropertyIntelligenceSnapshot

Resultado estructurado de Intelligence para una Property o Listing.

Campos conceptuales:

- id
- propertyId
- listingId opcional
- estimatedValue
- estimatedRent
- demandLevel
- pricePosition
- comparableCount
- confidence
- methodologyVersion
- generatedAt
- demoSynthetic

No utilizar un único score opaco como representación de todo.

---

## Comparable

Los comparables pueden modelarse mediante relación persistida o proyección calculada según necesidad técnica.

Conceptualmente deben conservar:

- subjectProperty/listing;
- comparableProperty/listing;
- similarity/context;
- distance;
- relevant metrics;
- calculation version.

La decisión exacta de persistencia puede tomarse durante implementación del Intelligence Engine.

---

## Opportunity

No debe ser una entidad permanente obligatoria.

Una oportunidad es principalmente un resultado calculado a partir de:

- mercado;
- demanda;
- precio;
- comparables;
- ubicación;
- contexto.

Puede cachearse/materializarse si el rendimiento lo exige.

No convertir “oportunidad” en atributo estático de una Property.

---

# 13. Match

## Match

Representa una coincidencia calculada entre demanda/interés y una propiedad/publicación.

Puede relacionar:

- User ↔ Listing;
- Lead ↔ Listing;
- demanda agregada ↔ cartera profesional.

Campos conceptuales cuando se persista:

- id
- subjectType
- subjectId
- listingId
- score estructurado
- reasons
- methodologyVersion
- generatedAt
- expiresAt opcional

Match debe ser explicable.

No revelar información personal no autorizada.

---

# 14. Conversaciones

## Conversation

Campos conceptuales:

- id
- listingId opcional
- operationId opcional
- createdAt
- updatedAt

Debe mantener contexto inmobiliario.

---

## ConversationParticipant

Campos:

- conversationId
- userId
- joinedAt
- status

Un usuario solo puede acceder a conversaciones en las que participa o tenga permiso administrativo explícito.

---

## Message

Campos conceptuales:

- id
- conversationId
- senderId
- content
- createdAt
- editedAt opcional
- status cuando corresponda

No construir mensajería generalista.

---

# 15. Visitas

## Visit

Representa una visita a un Listing.

Campos conceptuales:

- id
- listingId
- requestedByUserId
- hostUserId o relación profesional correspondiente
- scheduledAt
- status
- cancellationReason
- result
- createdAt
- updatedAt
- completedAt opcional
- cancelledAt opcional

Estados principales:

- REQUESTED
- CONFIRMED
- COMPLETED
- CANCELLED
- NO_SHOW

`REMINDER` no es estado de Visit.

Los recordatorios pertenecen a Task/Event/Notification.

---

# 16. Oferta

## Offer

Representa una propuesta económica/comercial.

Campos conceptuales:

- id
- listingId
- createdByUserId
- amount
- currency
- conditions
- status
- expiresAt
- createdAt
- updatedAt

Estados detallados se definen en `04-STATE-MACHINES.md`.

Una Offer aceptada puede crear Operation.

No equivale a Operation completada.

---

## OfferRevision

Representa revisión/contraoferta.

Campos conceptuales:

- id
- offerId
- createdByUserId
- amount
- conditions
- createdAt

Nunca sobrescribir el histórico de negociación.

La Offer puede reflejar la versión actual, pero las revisiones permanecen.

No crear una entidad `Negotiation` separada en v0.4 salvo necesidad técnica demostrada.

---

# 17. Puja

## Auction

Campos conceptuales:

- id
- listingId
- createdBy
- startsAt
- endsAt
- status
- rules
- createdAt
- updatedAt

---

## Bid

Campos:

- id
- auctionId
- bidderId
- amount
- currency
- status
- createdAt

Las identidades de pujadores no deben exponerse públicamente.

El final de Auction selecciona un candidato ganador.

Ganador no equivale a venta completada.

Debe pasar validaciones antes de crear/continuar Operation.

---

# 18. Operación

## Operation

Entidad central de la fase transaccional.

Campos conceptuales:

- id
- listingId
- sourceOfferId opcional
- sourceAuctionId opcional
- createdVia
- type
- status
- agreedAmount
- currency
- startedAt
- completedAt
- cancelledAt
- cancellationReason
- createdAt
- updatedAt

Operation debe preservar su propio contexto económico acordado.

`createdVia` solo admite `OFFER` o `AUCTION`. Para OFFER, `sourceOfferId` es obligatorio y `sourceAuctionId` nulo; para AUCTION ocurre lo inverso. Nunca ambos ni ninguno. La procedencia es inmutable. En Auction, la Auction conserva la Bid seleccionada: `Operation → Auction → selected Bid`.

Cambios posteriores en Listing no pueden modificar automáticamente sus condiciones.

---

## OperationParticipant

Representa participantes.

Campos:

- id
- operationId
- userId opcional
- organizationId opcional
- participantRole
- status
- createdAt

Cada participant tiene exactamente un sujeto: `userId` XOR `organizationId`. Roles mínimos: BUYER, SELLER, TENANT, LANDLORD y AGENCY. SALE admite BUYER/SELLER/AGENCY; RENT TENANT/LANDLORD/AGENCY. Los participantes se derivan por backend al crear Operation; son snapshot histórico, no autorización global actual.

Roles conceptuales según operación:

- BUYER
- SELLER
- TENANT
- LANDLORD
- AGENCY
- PROFESSIONAL

No llenar Operation con múltiples IDs específicos si la relación de participantes resuelve el problema de forma más extensible.

---

# 19. Requisitos

## Requirement

Representa algo necesario para avanzar en Operation.

Campos conceptuales:

- id
- operationId
- type
- requiredFromParticipantId
- status
- dueAt opcional
- completedAt opcional
- metadata
- createdAt

Puede representar necesidad de:

- documento;
- verificación;
- contrato;
- firma;
- pago;
- otra condición ya aprobada.

No utilizar Requirement para crear un motor BPM genérico.

Su objetivo es permitir saber:

“qué falta para completar esta operación”.

---

# 20. Documentos

## Document

Representa metadata y estado de un documento.

Campos conceptuales:

- id
- ownerUserId opcional
- ownerOrganizationId opcional
- propertyId opcional
- operationId opcional
- type
- status
- storageKey
- hash opcional
- visibility/accessPolicy
- uploadedAt
- submittedAt
- validatedAt
- rejectedAt
- rejectionReason
- expiresAt
- createdAt
- updatedAt
- documentFamilyId
- version
- supersedesDocumentId opcional

Estados se definen en State Machines.

El acceso a Document depende de:

- relación;
- propósito;
- autorización;
- estado;
- permisos.

Ser participante en una operación no implica acceso universal a todos sus documentos.

Cada corrección crea nueva versión inmutable: `documentFamilyId` identifica el documento lógico, `version` incrementa y `supersedesDocumentId` encadena la versión previa. Un archivo existente no cambia de `storageKey`; las versiones históricas permanecen. Una Requirement documental solo se completa con una versión VALIDATED adecuada.

## DocumentAccessGrant

Autorización explícita de acceso a un Document concreto/version concreta: `id`, `documentId`, `userId` XOR `organizationId`, `purpose`, `status`, `grantedByUserId`, `validFrom`, `validUntil`, `createdAt`, `revokedAt`. Purpose mínimos: REVIEW, OPERATION, SIGNATURE_PREPARATION y SUPPORT; status ACTIVE, REVOKED, EXPIRED. Grant activo y vigente concede acceso; no se propaga automáticamente a versiones futuras.

PRIVATE permite owner/proceso legítimo según policy; SHARED_AUTHORIZED exige grant/policy explícita; OPERATIONAL nunca significa todos los participants.

---

# 21. Verificación

## Verification

Representa una comprobación verificable.

Campos conceptuales:

- id
- subjectType
- subjectId
- verificationType
- status
- provider
- providerReference opcional
- verifiedAt
- expiresAt
- metadata segura
- createdAt
- updatedAt

Subjects iniciales:

- USER
- PROPERTY
- ORGANIZATION

No reducir verificación a `verified: boolean`.

---

# 22. Confianza

## TrustEvidence

Representa evidencia verificable relevante para confianza.

Ejemplos:

- identidad verificada;
- inmueble verificado;
- operación completada;
- visita cumplida;
- cancelación;
- incidencia;
- comportamiento operativo.

Campos conceptuales:

- id
- subjectType
- subjectId
- evidenceType
- sourceResourceType
- sourceResourceId
- weight/context interno cuando corresponda
- occurredAt
- createdAt

Las evidencias deben ser explicables y trazables.

---

## TrustSnapshot

Opcionalmente materializa una evaluación derivada para rendimiento.

Campos conceptuales:

- id
- subjectType
- subjectId
- level
- explanationData
- methodologyVersion
- generatedAt

No utilizar una puntuación arbitraria pública como único criterio de confianza.

---

# 23. Contratos

## ContractTemplate

Representa plantilla de contrato demo/versionable.

Campos conceptuales:

- id
- type
- version
- status
- templateReference
- createdAt

---

## Contract

Representa documento contractual generado para una Operation.

Campos:

- id
- operationId
- templateId opcional
- type
- version
- status
- storageKey
- generatedAt
- createdAt
- updatedAt

Un contrato generado debe preservar su contenido/versionado.

---

# 24. Firma

## Signature

Representa una firma requerida sobre un Contract.

Campos conceptuales:

- id
- contractId
- signerUserId
- provider
- providerReference
- status
- requestedAt
- signedAt
- failedAt
- createdAt
- updatedAt

Un Contract puede requerir varias Signature.

El estado no puede ser determinado únicamente por frontend.

---

# 25. Pago

## Payment

Representa una obligación económica interna asociada a Operation, no un intento concreto de PSP.

Campos conceptuales:

- id
- operationId
- payerUserId
- amount
- currency
- concept
- status
- confirmedAt
- cancelledAt opcional
- refundedAt opcional
- createdAt
- updatedAt

Estados: PENDING, IN_PROGRESS, CONFIRMED, CANCELLED, REFUND_PENDING, REFUNDED. `amount` y currency son autoritativos en backend.

## PaymentAttempt

Intento concreto: `id`, `paymentId`, provider, `providerReference`, `idempotencyKey`, status, `failureCode`/`failureReason` seguros y timestamps `initiatedAt`, `processingAt`, `confirmedAt`, `failedAt`, `cancelledAt`, `createdAt`, `updatedAt`. Estados INITIATED, PROCESSING, CONFIRMED, FAILED, CANCELLED. Retry crea otro Attempt; los provider event IDs se deduplican en registro técnico de ProviderEvent, no en Payment.

El importe autoritativo se calcula/valida en backend.

No aceptar cantidad arbitraria del frontend como fuente de verdad.

---

# 26. Comisión

## Commission

Representa comisión BenHouse o comisión gestionada según reglas aprobadas.

Campos conceptuales:

- id
- operationId
- paymentId opcional
- type
- rate
- amount
- currency
- status
- createdAt
- settledAt

Separar siempre:

- importe de Operation;
- Payment;
- ingresos/comisión BenHouse.

El 2% inicial debe ser configuración, no constante rígida enterrada en lógica.

---

# 27. Tareas

## Task

Representa una acción pendiente para un usuario/participante.

Campos conceptuales:

- id
- userId
- operationId opcional
- resourceType
- resourceId
- type
- status
- dueAt
- completedAt
- createdAt

Ejemplo:

“Adjuntar documento de identidad”.

No permitir marcar manualmente como completada una Task cuya resolución depende de una condición real no satisfecha.

El sistema puede completarla automáticamente cuando el requisito asociado se resuelve.

---

# 28. Notificaciones

## Notification

Representa información enviada/presentada al usuario.

Campos conceptuales:

- id
- userId
- type
- title
- content
- resourceType
- resourceId
- channel
- status
- createdAt
- readAt

Una Notification no es una Task.

Puede informar de una Task, pero son conceptos distintos.

---

# 29. Actividad

## Activity

Representa una proyección de acontecimientos relevantes para el usuario.

Puede construirse mediante eventos persistidos/proyecciones.

Campos conceptuales cuando se materialice:

- id
- userId
- eventType
- resourceType
- resourceId
- payload seguro
- occurredAt

Activity no sustituye DomainEvent.

Su función es UX.

---

# 30. Eventos de dominio

## DomainEvent / OutboxEvent

Representa un acontecimiento de negocio que otros procesos deben poder consumir.

Campos conceptuales:

- id
- eventType
- aggregateType
- aggregateId
- payload
- occurredAt
- createdAt
- processingStatus
- processedAt
- retryCount

Cuando se requiera consistencia, el evento se escribe en outbox dentro de la misma transacción que el cambio de dominio.

---

# 31. Auditoría

## AuditEvent

Representa trazabilidad de acciones relevantes.

Campos conceptuales:

- id
- actorUserId opcional
- actorType
- action
- resourceType
- resourceId
- previousState opcional
- newState opcional
- metadata segura
- requestId opcional
- occurredAt

Regla:

los eventos críticos de auditoría se añaden.

No deben ser editables desde la experiencia normal.

---

# 32. Analytics

## AnalyticsEvent

Representa comportamiento medible.

Campos conceptuales:

- id
- eventType
- userId opcional
- anonymousSessionId opcional
- listingId opcional
- propertyId opcional
- locationId opcional
- organizationId opcional
- metadata
- demoSynthetic
- occurredAt

Ejemplos:

- SEARCH_PERFORMED
- PROPERTY_VIEWED
- FAVORITE_ADDED
- VISIT_REQUESTED

No utilizar frontend analytics como fuente fiable para:

- PAYMENT_CONFIRMED
- OPERATION_COMPLETED
- CONTRACT_SIGNED

Esos acontecimientos provienen del backend.

---

# 33. Incidencias

## Issue

Representa una incidencia operativa.

Campos conceptuales:

- id
- operationId opcional
- propertyId opcional
- reportedByUserId
- type
- severity
- status
- description
- createdAt
- resolvedAt

No pretende ser sistema jurídico ni helpdesk enterprise.

---

# 34. CRM

## Lead

Representa una oportunidad comercial profesional.

Campos conceptuales:

- id
- organizationId
- userId opcional
- listingId opcional
- source
- status
- assignedToUserId opcional
- createdAt
- updatedAt

Siempre que sea posible se enlaza con User existente.

No duplicar datos personales innecesariamente.

---

## CRMNote

Campos:

- id
- organizationId
- leadId
- authorUserId
- content
- createdAt

---

## CRMTask

Puede reutilizar `Task` si el modelo de permisos y contexto lo permite.

Solo crear una entidad CRMTask separada si durante implementación existe una necesidad funcional P1 claramente demostrada.

Preferencia:

reutilizar Task con contexto profesional.

---

# 35. Analítica privada de propietario/profesional

No necesita una entidad gigante de “OwnerAnalytics”.

Debe calcularse/proyectarse a partir de:

- AnalyticsEvent;
- Favorite;
- Conversation;
- Visit;
- Offer;
- Operation.

Puede utilizar agregados/materialized views/caches cuando el rendimiento lo requiera.

No duplicar la fuente de verdad.

---

# 36. Entidades que NO deben existir como núcleo independiente en v0.4

Evitar salvo necesidad técnica demostrada:

- BuyerUser
- OwnerUser
- InvestorUser
- CRMUser
- CRMProperty
- CRMVisit
- CRMOffer
- ReputationScore
- Opportunity permanente
- Negotiation independiente
- Wallet visible
- BenPoints
- PaymentIntent como sustituto de Payment
- Reminder como duplicación de Task/Event
- módulos separados por cada modalidad de alquiler

---

# 37. Relaciones maestras

Representación conceptual simplificada:

USER
├── ORGANIZATION MEMBERSHIP
├── FAVORITES
├── SAVED SEARCHES
├── CONVERSATIONS
├── VISITS
├── OFFERS
├── BIDS
├── OPERATIONS
├── TASKS
└── NOTIFICATIONS

ORGANIZATION
├── MEMBERS
├── LISTINGS
├── LEADS
└── OPERATIONS

PROPERTY
├── LOCATION
├── PROPERTY UNITS
├── MEDIA
├── VERIFICATIONS
├── INTELLIGENCE SNAPSHOTS
└── LISTINGS

LISTING
├── PRICE HISTORY
├── FAVORITES
├── VISITS
├── OFFERS
└── AUCTION
    └── BIDS

OPERATION
├── PARTICIPANTS
├── REQUIREMENTS
├── DOCUMENTS
├── CONTRACTS
│   └── SIGNATURES
├── PAYMENTS
│   └── COMMISSIONS
└── ISSUES

TRANSVERSAL
├── DEMAND SIGNALS
├── MARKET SNAPSHOTS
├── MATCH
├── TRUST EVIDENCE
├── TASKS
├── NOTIFICATIONS
├── ACTIVITY
├── DOMAIN EVENTS
├── ANALYTICS EVENTS
└── AUDIT EVENTS

---

# 38. Delete policy

Los recursos críticos no deben eliminarse físicamente de forma indiscriminada.

Especialmente:

- Operation;
- Offer aceptada/rechazada históricamente;
- Contract;
- Signature;
- Payment;
- AuditEvent;
- DomainEvent crítico;
- Verification relevante;
- documentación asociada a operación según política de retención.

Utilizar estados, archivado o estrategias de retención cuando corresponda.

La política jurídica definitiva de retención se validará antes de producción comercial real.

---

# 39. Timestamps

Todas las entidades relevantes deben utilizar timestamps consistentes.

Por defecto:

- createdAt
- updatedAt cuando pueda cambiar

Y timestamps específicos del dominio cuando aporten significado:

- publishedAt
- confirmedAt
- signedAt
- completedAt
- cancelledAt
- verifiedAt

No deducir acontecimientos críticos únicamente de `updatedAt`.

---

# 40. Dinero

Los importes monetarios deben manejarse sin errores de punto flotante.

La implementación debe utilizar una estrategia segura compatible con PostgreSQL/Prisma.

Ejemplos aceptables:

- integer en unidad mínima;
- Decimal adecuadamente gestionado.

La decisión física final debe quedar documentada antes de crear el schema definitivo.

Siempre conservar:

- amount;
- currency.

No asumir EUR de forma irreversible en el modelo aunque España sea el mercado inicial.

---

# 41. IDs

Utilizar identificadores no predecibles apropiados para recursos expuestos públicamente.

La elección concreta puede ser UUID/CUID equivalente compatible con el stack.

Evitar IDs secuenciales públicamente explotables cuando puedan facilitar enumeración de recursos.

La autorización sigue siendo obligatoria independientemente del tipo de ID.

---

# 42. Privacidad

No todas las relaciones del dominio se exponen a todos los participantes.

Ejemplos:

- bidderId no público;
- documentación privada;
- TrustEvidence interna sensible;
- señales antifraude;
- analítica privada del propietario;
- datos de otros usuarios.

Las DTO/projections de API deben controlar exposición.

No devolver entidades Prisma completas directamente al cliente.

---

# 43. Demo y producción

Las entidades que reciban datos sintéticos relevantes para métricas deben poder identificar su procedencia.

Utilizar cuando corresponda:

- source;
- demoSynthetic;
- dataset/version.

Los datos sintéticos jamás deben confundirse internamente con datos reales de mercado.

---

# 44. Integridad

El schema físico debe reforzar invariantes mediante:

- unique constraints;
- foreign keys;
- índices;
- restricciones;
- transacciones;
- estados válidos.

Ejemplos:

- Favorite único por User + Listing;
- OrganizationMember único por User + Organization cuando corresponda;
- relaciones obligatorias protegidas;
- índices en búsquedas frecuentes;
- índices geográficos;
- referencias económicas consistentes.

---

# 45. Regla para crear nuevas entidades durante implementación

Codex no debe crear una nueva entidad de dominio simplemente porque facilite una función local.

Antes debe comprobar:

1. ¿ya existe el concepto?
2. ¿es una proyección?
3. ¿puede ser cálculo?
4. ¿puede ser relación?
5. ¿puede resolverse con una entidad existente?
6. ¿es realmente persistencia o solo DTO/view model?

Solo crear una nueva entidad si representa un concepto de dominio persistente real.

Si la nueva entidad afecta el modelo de dominio aprobado:

- clasificar P0/P1/P2;
- informar antes;
- no ampliar v0.4 silenciosamente.

---

# 46. Próxima traducción a Prisma

Cuando llegue la fase de implementación, este documento deberá traducirse a un schema Prisma concreto.

Antes de aceptar el schema se realizará un review específico para:

- relaciones;
- cascadas;
- nullability;
- uniques;
- índices;
- PostGIS;
- dinero;
- timestamps;
- enums;
- soft delete/archivado;
- integridad;
- rendimiento.

No asumir que esta documentación conceptual implica que cada elemento será una tabla independiente.

Algunos conceptos pueden materializarse mediante:

- tablas;
- relaciones;
- proyecciones;
- views;
- JSON validado;
- snapshots;
- eventos.

Debe elegirse la representación más simple que mantenga integridad y funcionalidad.

---

# 47. Criterio de cierre del modelo

El modelo se considera correcto cuando puede representar sin contradicciones:

1. usuario con múltiples capacidades;
2. agencia con varios miembros;
3. propiedad con publicaciones diferentes;
4. venta;
5. larga duración;
6. temporada;
7. vacacional;
8. habitaciones;
9. búsqueda/mapa;
10. Intelligence;
11. favoritos;
12. alertas;
13. visitas;
14. conversación;
15. oferta/contraoferta;
16. puja;
17. operación;
18. documentación;
19. verificación/confianza;
20. contrato;
21. múltiples firmas;
22. pagos;
23. comisión;
24. actividad;
25. CRM;
26. analytics;
27. auditoría;
28. cancelación;
29. historial;
30. reentrada de inmueble al mercado.
