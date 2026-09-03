# BenHouse v0.4 — Plan de Pruebas

## Objetivo

Definir la estrategia oficial de pruebas de BenHouse v0.4.

Este documento debe impedir:

- validar solo el happy path;
- avanzar con P0/P1 abiertos;
- depender de tests manuales únicamente;
- probar módulos aislados sin comprobar el journey;
- ignorar autorización;
- ignorar concurrencia;
- ignorar idempotencia;
- ignorar fallos de providers;
- aprobar una demo visual que funcionalmente no sea fiable.

BenHouse v0.4 debe probarse por capas y también de extremo a extremo.

---

# 1. Principio general

La calidad no se valida al final.

Cada bloque de construcción sigue:

IMPLEMENTAR
→ REVISAR
→ TESTEAR
→ CORREGIR
→ VOLVER A TESTEAR
→ COMMIT

No avanzar al siguiente bloque con P0/P1 sin resolver salvo dependencia técnica documentada y aprobada.

---

# 2. Pirámide de pruebas

BenHouse utilizará varias capas:

1. Unit tests
2. Domain/state tests
3. Integration tests
4. API tests
5. Database/PostGIS tests
6. Provider contract tests
7. Security/authorization tests
8. E2E tests
9. Performance/load tests
10. Visual/manual QA
11. Demo journey tests

Ninguna capa sustituye completamente a otra.

---

# 3. Unit tests

Objetivo:

probar lógica aislada y determinista.

Ejemplos:

- cálculos de comisión;
- validación de precios;
- reglas de disponibilidad;
- comparables;
- scoring/explicación estructurada de Match;
- transición permitida;
- normalización de provider states;
- utilidades de fechas;
- filtros.

No escribir tests triviales de getters sin valor.

---

# 4. Domain tests

Especialmente importantes.

Probar:

- invariantes;
- transiciones;
- reglas de negocio;
- errores;
- permisos contextuales cuando corresponda.

Ejemplo:

Listing cambia de precio
→ Offer existente no cambia.

---

# 5. State machine tests

Obligatorios para:

- Listing;
- Visit;
- Offer;
- Auction;
- Document;
- Verification;
- Contract;
- Signature;
- Payment;
- Requirement;
- Task;
- Operation.

Cada máquina debe probar:

1. transición válida;
2. transición inválida;
3. estado final;
4. reintento cuando proceda;
5. cancelación;
6. expiración;
7. actor no autorizado cuando sea relevante.

---

# 6. Operation tests

Máxima prioridad.

Probar flujo completo:

CREATED
→ REQUIREMENTS_PENDING
→ DOCUMENTS_PENDING
→ DOCUMENTS_UNDER_REVIEW
→ READY_FOR_CONTRACT
→ CONTRACT_PREPARATION
→ SIGNATURE_PENDING
→ SIGNED
→ PAYMENT_PENDING
→ PAYMENT_PROCESSING
→ PAYMENT_CONFIRMED
→ COMPLETED

Y caminos alternativos:

- document rejected;
- signature failed;
- PaymentAttempt FAILED;
- cancellation;
- retry.

---

# 7. Integration tests

Objetivo:

comprobar colaboración real entre:

- NestJS;
- Prisma;
- PostgreSQL;
- PostGIS;
- worker;
- providers mock.

Usar base de datos de test real cuando sea necesario.

No mockear Prisma para todos los tests de integración.

---

# 8. Database tests

Probar:

- foreign keys;
- unique constraints;
- nullability;
- valid states;
- transaction rollback;
- indexes clave;
- integrity.

Ejemplos:

- Favorite duplicado falla/no duplica;
- OrganizationMember duplicado controlado;
- Operation sin Listing inválida cuando el modelo lo requiera.

---

# 9. PostGIS tests

Probar:

- bbox;
- polygon;
- radius cuando se implemente;
- contains/intersects;
- geospatial indexes;
- coordenadas;
- búsqueda por viewport.

Utilizar fixtures conocidos.

---

# 10. Polygon regression test

Preparar polígono estable sobre Punta Prima.

Expected:

mismo conjunto lógico de Listings con seed fijo.

Esto evita regresiones en queries geoespaciales.

---

# 11. Search tests

# 10.1 Availability tests

- Búsqueda: rango totalmente libre incluye Listing; rango parcialmente ocupado o bloqueado lo excluye.
- Solapamiento: dos Operations incompatibles sobre el mismo rango solo permiten una confirmación.
- Límite: `A.endsAt = B.startsAt` no es solapamiento.
- PropertyUnit: Room 1 libre y Room 2 ocupada mantiene disponible Room 1.
- Conflicto vivienda completa/unidad: ocupaciones incompatibles se rechazan.
- Cancelación: Operation cancelada libera disponibilidad sin borrar historial crítico.
- Autorización: actor ajeno no puede bloquear.
- Protección de fuente: owner no puede desbloquear `OCCUPIED` derivado de Operation; debe usar workflow de Operation.

Probar filtros:

- transactionType;
- rentalMode;
- location;
- price;
- rooms;
- bathrooms;
- area;
- propertyType;
- features;
- availability;
- bbox;
- polygon;
- sort;
- pagination.

---

# 12. Search list/map consistency

Regla obligatoria:

misma búsqueda + mismos filtros
→ list y map representan el mismo universo lógico.

Map puede usar proyección reducida.

No puede utilizar lógica de filtrado diferente.

---

# 13. Search empty state

Filtros imposibles:

expected:

- 200;
- lista vacía;
- UX empty state;
- sin error técnico.

---

# 14. Search invalid filters

Ejemplos:

- minPrice > maxPrice;
- polygon inválido;
- page size excesivo;
- enum inexistente.

Expected:

error controlado.

---

# 15. Intelligence tests

Probar:

- MarketSnapshot;
- PropertyIntelligenceSnapshot;
- comparables;
- demand;
- opportunity;
- Match.

Comprobar:

- methodologyVersion;
- sampleSize;
- confidence;
- demoSynthetic;
- no NaN;
- no divide by zero.

---

# 16. Intelligence determinism

Con mismos inputs + misma metodología:

resultado estructurado debe ser reproducible.

AI explanation puede variar si usa LLM.

Las métricas no.

---

# 17. AI fallback test

AIProvider deshabilitado/fallando.

Expected:

- Property Intelligence sigue disponible;
- UI sigue funcionando;
- no bloquea Search/Operation;
- explicación fallback comprensible.

---

# 18. Auth tests

Probar:

- register;
- login;
- logout;
- session;
- expired session;
- revoked session;
- forgot password;
- reset password;
- email verification.

Negative:

- wrong password;
- invalid token;
- reused reset token;
- brute-force/rate limit.

---

# 19. Permissions tests

Cada endpoint privado importante necesita:

### Positive
actor autorizado.

### Negative
actor autenticado no relacionado.

### Anonymous
sin sesión cuando aplique.

### Wrong organization
tenant isolation.

### Revoked member
acceso revocado.

---

# 20. IDOR/BOLA matrix

# 19.1 PropertyAuthorization y publisher tests

- OWNER, MANAGER y PUBLISHER válidos; autorización revocada/expirada; exactamente un subject.
- User A no crea Listing sobre Property de B.
- Miembro autorizado publica para Organization autorizada; miembro de A no publica como B.
- Responsible member pertenece y está ACTIVE en publisherOrganization.
- Membership revocada y PropertyAuthorization revocada eliminan acciones futuras.
- Revocación con Listing activo aplica transición segura/PAUSED sin reescribir publisher, Operation ni Audit.
- Mass assignment de ownership, publisher o status se rechaza.

Tests específicos:

1. Property ajena.
2. Listing ajeno.
3. Conversation ajena.
4. Visit ajena.
5. Offer ajena.
6. Auction privada ajena.
7. Operation ajena.
8. Document ajeno.
9. Verification ajena.
10. Contract ajeno.
11. Signature ajena.
12. Payment ajeno.
13. Lead de otra Organization.
14. CRMNote de otra Organization.

Todos deben fallar de forma segura.

---

# 21. Mass assignment tests

Enviar campos prohibidos:

- status;
- admin;
- role;
- verified;
- ownerId;
- payerId;
- signerId;
- amount crítico;
- providerReference.

Expected:

ignorado/rechazado según contrato.

Nunca aplicado silenciosamente.

---

# 22. Offer tests

Probar:

- create;
- send;
- revise;
- accept;
- reject;
- withdraw;
- expire.

Invariantes:

- price change no modifica offer;
- revisions se conservan;
- accepted ≠ completed.

---

# 23. Concurrent Offer Acceptance

Probar `userId` XOR `organizationId`; SALE rechaza TENANT y RENT BUYER; Offer/Auction crean provenance exclusiva e inmutable; retries producen una sola Operation; frontend no inyecta participants; revocación quita permisos sin borrar historial; `agreedAmount` no cambia tras cambios de Listing.

Caso obligatorio:

Offer A
Offer B

dos accepts simultáneos.

Expected:

solo una Operation compatible.

La otra acción:

409/conflict o resultado equivalente seguro.

Nunca dos Operations incompatibles.

---

# 24. Offer acceptance rollback

Forzar fallo al crear Operation.

Expected:

- Offer no queda ACCEPTED;
- Listing no queda reservado parcialmente;
- outbox no contiene evento falso.

---

# 25. Auction tests

Probar:

- schedule;
- start;
- bid;
- outbid;
- end;
- winner validation;
- cancellation.

Negative:

- bid antes de start;
- bid después de endsAt;
- bid sobre cancelled auction;
- bid no autorizada.

---

# 26. Auction concurrency

Caso:

worker intenta cerrar Auction
mientras entra Bid límite.

Expected:

regla temporal/transaction decide de forma consistente.

Nunca aceptar Bid después del cierre efectivo.

---

# 27. Visit tests

Probar:

- request;
- confirm;
- cancel;
- complete;
- no-show.

Negative:

- complete cancelled visit;
- confirm unauthorized;
- confirm invalid state.

---

# 28. Visit reminder test

Visit CONFIRMED próxima.

Expected:

reminder.

Visit CANCELLED antes.

Expected:

no reminder.

---

# 29. Messaging tests

Probar:

- create conversation;
- send message;
- list conversations;
- unread;
- participant access.

Negative:

- sender spoofing;
- conversation IDOR;
- oversized message;
- rate abuse básico.

---

# 30. Document tests

Probar:

- upload-intent;
- complete-upload;
- submit;
- validate;
- reject;
- download-intent;
- expiry.

Negative:

- unauthorized access;
- invalid MIME;
- oversized file;
- invalid storage completion;
- self-validation.

---

# 31. Document rejection recovery

Probar familia/versiones V1→V2→V3, unicidad family+version, supersede, inmutabilidad de storageKey y concurrencia de versiones. V1 REJECTED crea V2 sin mutar V1; Requirement solo completa con versión VALIDATED. Grants válidos permiten descargar; sin grant, expirado, revocado o de V1 contra V2 rechazan. Grant de Organization exige miembro ACTIVE y policy.

Document:
REJECTED.

Expected:

- Requirement pendiente;
- Task creada;
- Operation abierta.

Después:

nuevo upload
→ review
→ validated
→ Requirement completed.

---

# 32. Verification tests

Probar:

- start;
- verified;
- failed;
- expired;
- revoked;
- retry.

Frontend nunca puede marcar VERIFIED.

---

# 33. Trust tests

Probar:

- evidence creation;
- safe public projection;
- sensitive evidence hidden;
- snapshot recalculation when used.

No probar score opaco inexistente.

---

# 34. Contract tests

Probar:

- generate;
- send;
- partial signatures;
- signed;
- superseded;
- cancelled.

No sobrescribir contrato firmado.

---

# 35. Multiple Signature test

Contract requiere A y B.

A SIGNED.
B PENDING.

Expected:

Contract:
PARTIALLY_SIGNED

Operation:
SIGNATURE_PENDING

Después B SIGNED:

Contract:
SIGNED

Operation puede avanzar según reglas.

---

# 36. Signature webhook tests

Probar:

- valid signature;
- invalid signature;
- duplicate event;
- unknown signature;
- wrong state;
- expired request.

Nunca depender de redirect.

---

# 37. Payment tests

Probar múltiples Attempts, retry como Attempt nuevo, tres fallos y éxito, idempotency, webhook duplicado, refund y recuperación de Operation.

Probar:

- create;
- initiate;
- processing;
- confirmed;
- failed;
- retry;
- refund.

Sandbox/mock.

---

# 38. Payment amount tampering

Frontend envía importe manipulado.

Expected:

backend recalcula/valida.

Nunca crear pago con amount manipulado.

---

# 39. Duplicate Payment Webhook

Mismo providerEventId dos veces.

Expected:

- un cambio lógico;
- una Commission;
- una transición Operation;
- no duplicación.

---

# 40. Payment failure recovery

PaymentAttempt FAILED.

Expected:

- Operation abierta;
- PAYMENT_PENDING/recoverable;
- Task reintento;
- no CANCELLED automática.

Después retry success:

Operation continúa.

---

# 41. Commission tests

Probar:

- rate configurada;
- amount calculation;
- rounding;
- cancellation;
- reversal cuando proceda.

No asumir tratamiento fiscal final.

---

# 42. Event/outbox tests

Probar:

- outbox dentro de transaction;
- worker processing;
- retry;
- failure;
- dead letter;
- correlation;
- idempotent handlers.

---

# 43. Transaction rollback + outbox

Forzar error antes de commit.

Expected:

- no domain change;
- no event persistido.

Forzar worker crash después de commit.

Expected:

- evento sigue disponible;
- se procesa tras recuperación.

---

# 44. Event duplication

Procesar mismo event dos veces.

Expected:

sin efectos duplicados.

Especialmente:

- Notification;
- Task;
- Commission;
- Operation transition.

---

# 45. Event ordering

Procesar evento antiguo después de estado más nuevo.

Expected:

no retroceder/corromper agregado.

---

# 46. Worker restart

Simular:

- evento PENDING;
- worker cae;
- worker vuelve.

Expected:

evento se procesa.

---

# 47. Dead letter test

Provider permanentemente falla.

Tras retries:

evento/handler observable como DEAD_LETTER.

No desaparece silenciosamente.

---

# 48. Provider contract tests

Para:

- PaymentProvider;
- SignatureProvider;
- IdentityProvider;
- StorageProvider;
- EmailProvider;
- AIProvider.

Mock y adapter real deben respetar semántica interna.

---

# 49. Maps tests

Separar:

### Backend
PostGIS.

### Frontend
render/interacción básica.

### Staging E2E
Google Maps real.

No hacer todos los tests dependientes de Google externo.

---

# 50. Storage tests

Probar:

- public media;
- private docs;
- signed upload;
- signed download;
- expired URL;
- unauthorized request;
- missing object.

---

# 51. Email tests

Mock/dev provider.

Probar eventos que deberían enviar:

- verify;
- reset;
- visit;
- offer;
- document;
- signature;
- payment.

Fallo de email:

no revierte dominio.

---

# 52. CRM tests

Probar:

- organization boundary;
- leads;
- assignment;
- status;
- notes;
- tasks;
- dashboard aggregates.

No duplicar User/Listing.

---

# 53. Owner analytics tests

Owner de Listing A:

puede ver agregados de A.

No puede ver:

- analytics de B;
- identidades de viewers;
- favoritos individuales.

---

# 54. Activity tests

Probar:

- price drop;
- visit;
- document;
- offer;
- contract;
- payment;
- operation.

Activity debe ser proyección segura.

---

# 55. Notification tests

Probar:

- own list;
- read;
- read-all;
- unread;
- failure delivery.

Usuario A no lee Notification de B.

READ no completa Task.

---

# 56. Task tests

Probar:

- auto-created;
- manually completable;
- auto-completed;
- cancelled;
- expired.

Requirement-linked Task no puede cerrarse si requisito real sigue pendiente.

---

# 57. API contract tests

Endpoints críticos deben validar:

- status code;
- response shape;
- error shape;
- authorization;
- state transition;
- event.

No depender solo de tests internos de service.

---

# 58. API error consistency

Probar:

- 401;
- 403;
- 404;
- 409;
- 422;
- 429.

Formato consistente.

No stack traces.

---

# 59. Security headers tests

En staging/production-like comprobar:

- CSP;
- nosniff;
- referrer policy;
- frame policy;
- HSTS cuando corresponda.

---

# 60. CORS tests

Origins permitidos:

funcionan.

Origins no permitidos:

rechazados.

No usar wildcard inseguro con credentials.

---

# 61. CSRF tests

Si estrategia final lo requiere:

probar:

- token/origin válido;
- request cross-site inválida;
- state-changing requests protegidos.

---

# 62. XSS tests

Inputs maliciosos en:

- property description;
- messages;
- CRM notes;
- AI explanation mock.

Expected:

render seguro.

---

# 63. Upload security tests

Fixtures:

- image válido;
- pdf válido;
- executable renombrado;
- MIME mismatch;
- archivo gigante.

Expected:

control según policy.

---

# 64. Open redirect test

Intentar callback/redirect externo arbitrario.

Expected:

rechazo.

---

# 65. Internal API tests

`/internal/*`

Usuario normal:

rechazado.

Service identity válida:

permitido.

No confiar solo en URL.

---

# 66. Admin tests

Probar capabilities.

Admin A con VERIFICATION_REVIEW:

puede revisar Verification.

No necesariamente Payment.

Admin sin capability financiera:

no modifica Payment.

---

# 67. Audit tests

Acciones críticas generan AuditEvent.

Probar:

- actor;
- resource;
- previous/new state;
- timestamp;
- reason cuando corresponda.

No secrets.

---

# 68. Demo seed tests

`seed:demo` debe:

- crear dataset;
- respetar invariantes;
- marcar synthetic;
- producir escenarios.

Repetición con misma seed:

resultado lógico reproducible.

---

# 69. Seed production guard

Intentar demo seed con production env.

Expected:

abort.

P0 si permite borrar/contaminar producción accidentalmente.

---

# 70. Data quality tests

Tras seed:

validar:

- coordenadas;
- precios;
- relations;
- orphan records;
- invalid states;
- impossible values;
- duplicate favorites;
- missing participants.

---

# 71. E2E — Journey usuario

Automatizar en la medida razonable:

1. login/register;
2. search;
3. map/list;
4. property;
5. intelligence;
6. favorite;
7. visit;
8. offer;
9. accept;
10. operation;
11. document;
12. contract;
13. signature sandbox;
14. payment sandbox;
15. completion;
16. history.

Este es el E2E prioritario.

---

# 72. E2E — Journey profesional

1. login;
2. organization;
3. portfolio;
4. demand;
5. match;
6. lead;
7. message;
8. visit;
9. offer;
10. operation.

---

# 73. E2E — Error recovery

1. Operation;
2. document rejected;
3. correction;
4. validation;
5. signature;
6. PaymentAttempt FAILED;
7. retry;
8. payment confirmed;
9. completed.

---

# 74. E2E — Permissions attack

Usuario A intenta navegar/manipular recursos de B mediante API directa.

Expected:

rechazo.

No limitar prueba a ocultar botones.

---

# 75. Browser matrix

MVP demo debe validarse al menos en navegadores modernos principales:

- Chrome;
- Edge;
- Safari cuando sea posible;
- Firefox.

Prioridad:

desktop + mobile responsive.

No perseguir navegadores legacy.

---

# 76. Device/responsive matrix

Probar al menos:

- desktop ancho;
- laptop;
- tablet;
- mobile ~390 px;
- mobile pequeño razonable.

Especial atención:

- Search;
- map;
- property;
- operation;
- dialogs/drawers.

---

# 77. Accessibility tests

Automáticos + manuales básicos.

Comprobar:

- labels;
- roles;
- keyboard;
- focus;
- contrast;
- alt;
- error association.

No declarar WCAG certification formal.

---

# 78. Keyboard test

Journey básico debe poder navegar razonablemente sin ratón.

Especialmente:

- forms;
- modals;
- filters;
- navigation;
- dialogs.

---

# 79. Visual regression

Puede introducirse para pantallas críticas si aporta valor.

Candidatos:

- Home;
- Search;
- Property;
- Operation.

No convertir v0.4 en proyecto de snapshot masivo.

---

# 80. Manual visual QA

Antes de demo revisar:

- spacing;
- typography;
- images;
- broken layouts;
- overflow;
- badges;
- states;
- mobile;
- browser console.

No aprobar solo porque tests backend pasan.

---

# 81. UX state QA

Cada pantalla importante debe probar:

- loading;
- loaded;
- empty;
- error;
- permission denied;
- success;
- disabled when applicable.

---

# 82. Demo quality QA

Prohibido en demo:

- TODO visible;
- Lorem Ipsum;
- botón roto;
- enlace vacío;
- imagen rota;
- console error continuo;
- datos en inglés no justificados;
- payment real;
- claims de datos reales cuando son synthetic.

---

# 83. Performance baseline

No fijar números arbitrarios sin medir, pero establecer objetivos razonables.

Medir:

- search latency;
- map projection;
- property page;
- API p95;
- DB queries;
- worker delay.

---

# 84. Search performance

Con dataset normal:

Search debe sentirse inmediata.

Con performance dataset:

medir degradación.

Revisar:

- indexes;
- N+1;
- query plans;
- payload.

---

# 85. Map performance

No enviar fichas completas para todos los markers.

Testear:

- varios cientos/miles de puntos según viewport;
- clustering;
- payload.

---

# 86. Database performance

Analizar queries críticas:

- search;
- bbox;
- polygon;
- owner analytics;
- CRM dashboard;
- operation load;
- activity.

Usar EXPLAIN cuando sea necesario.

---

# 87. N+1 tests/review

Revisar páginas:

- Search Results;
- CRM;
- Activity;
- Conversations;
- Operations.

Evitar query por item.

---

# 88. Load testing

Antes de cerrar demo/staging serio:

realizar pruebas de carga básicas.

Escenarios:

- Search concurrente;
- Property reads;
- login;
- favorite;
- messages;
- offers controladas.

No simular pagos masivos reales.

---

# 89. Stress testing

Buscar punto de fallo controlado.

Objetivo:

- detectar cuellos;
- comprobar recuperación;
- no perseguir cifras enterprise.

---

# 90. Worker load

Probar lote de:

- notifications;
- price-drop events;
- reminders;
- Intelligence recalc.

Medir backlog.

---

# 91. Resilience tests

Simular:

- DB temporary failure donde sea razonable;
- provider timeout;
- worker restart;
- email outage;
- AI outage;
- PSP sandbox outage mock.

El sistema debe degradar sin corrupción.

---

# 92. Observability tests

Comprobar que un fallo deja señales útiles:

- logs;
- requestId;
- eventId;
- dead letter;
- provider error class.

No logs silenciosos.

---

# 93. Test data isolation

Tests automatizados usan:

- DB aislada;
- storage aislado/mock;
- provider mock/sandbox.

No tocar staging compartido salvo suite E2E diseñada para ello.

---

# 94. Test determinism

Evitar tests flaky.

Controlar:

- clocks;
- random;
- provider responses;
- seed.

Utilizar fake clock cuando ayude para expiraciones/reminders.

---

# 95. Time-dependent tests

Probar:

- Offer expiration;
- Auction ending;
- Visit reminder;
- Signature expiration;
- Verification expiration;
- Task due.

No usar sleeps largos.

---

# 96. CI

Cuando se configure CI debe ejecutar progresivamente:

1. lint;
2. typecheck;
3. unit;
4. integration;
5. security-critical tests;
6. build.

E2E puede ejecutarse en pipeline específico si coste/tiempo lo recomienda.

---

# 97. Merge/commit quality gate

No aceptar bloque como verde si falla:

- build;
- typecheck;
- tests críticos;
- lint crítico;
- P0/P1.

Warnings deben revisarse, no ignorarse sistemáticamente.

---

# 98. P0 test failure

Cualquier test que demuestre:

- security bypass;
- data corruption;
- double payment;
- double Operation;
- invalid signature;
- document leak;
- broken core journey;

bloquea avance.

---

# 99. P1 test failure

Ejemplos:

- feature aprobada rota;
- permission defect limitado;
- error recovery roto;
- important responsive issue;
- provider integration unreliable;
- search/filter inconsistency.

Debe resolverse antes de cerrar bloque.

---

# 100. P2 test failure

Ejemplos:

- refinamiento visual;
- microcopy;
- pequeña inconsistencia no crítica;
- optimización futura.

Puede pasar a backlog si no afecta demo.

No utilizar P2 para esconder bugs funcionales.

---

# 101. Regression suite

Cada bug P0/P1 corregido debe dejar:

- test que fallaba;
- corrección;
- test verde.

Evitar reintroducción.

---

# 102. Bug workflow

Para bug:

1. reproducir;
2. clasificar;
3. aislar;
4. escribir/ajustar test;
5. corregir;
6. ejecutar tests;
7. revisar regresión;
8. commit.

No corregir a ciegas.

---

# 103. Final cross-document tests

Antes de lanzamiento demo verificar que implementación cumple:

- Scope;
- Domain;
- States;
- Permissions;
- API;
- Events;
- UX;
- Design;
- Integrations;
- Security;
- Demo Data.

No basta con que “funcione”.

Debe respetar Blueprint.

---

# 104. Demo rehearsal

Antes de enseñar a terceros:

hacer ensayo completo.

Usuario story.

Profesional story.

Error recovery.

Sin:

- reiniciar servidor;
- editar DB;
- usar consola;
- explicar bugs.

---

# 105. Demo reset rehearsal

Probar:

reset seguro
→ seed
→ servicios
→ demo.

Debe poder repetirse.

---

# 106. Evidence of quality

Antes de declarar v0.4 demo-ready guardar evidencia mínima:

- tests passing;
- build passing;
- no P0/P1;
- performance baseline;
- screenshots/QA;
- demo journey completed.

No necesita burocracia enterprise.

---

# 107. Tests fuera de alcance

No se requiere ahora:

- formal penetration test externo;
- certificación PCI propia;
- certificación WCAG;
- chaos engineering enterprise;
- multi-region disaster simulation;
- millions-user load test;
- full legal compliance certification.

Pueden llegar antes de producción real según necesidad.

---

# 108. Pre-production future gate

Antes de dinero/contratos reales será necesario ampliar:

- security audit;
- legal validation;
- privacy/GDPR;
- provider production validation;
- disaster recovery;
- backup/restore;
- monitoring;
- penetration testing según riesgo.

No confundir demo-ready con production-ready.

---

# 109. Criterio de cierre del plan de pruebas

El plan se considera suficiente cuando existe cobertura explícita para:

1. dominio;
2. states;
3. auth;
4. permissions;
5. IDOR/BOLA;
6. search;
7. map/PostGIS;
8. Intelligence;
9. favorites;
10. visits;
11. messaging;
12. offers;
13. auctions;
14. operations;
15. documents;
16. verification;
17. contracts;
18. signatures;
19. payments;
20. commissions;
21. events/outbox;
22. CRM;
23. analytics;
24. responsive;
25. accessibility;
26. security;
27. concurrency;
28. idempotency;
29. provider failure;
30. E2E;
31. load/performance;
32. demo rehearsal.
