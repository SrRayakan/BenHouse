# BenHouse v0.4 — Definition of Done

## Objetivo

Definir exactamente cuándo una funcionalidad, bloque o la propia versión BenHouse v0.4 puede considerarse terminada.

Este documento debe impedir:

- marcar como “hecho” algo que solo funciona visualmente;
- cerrar módulos con bugs críticos;
- avanzar con P0/P1;
- considerar suficiente un happy path;
- aceptar código sin tests;
- aceptar código sin permisos;
- aceptar UI sin responsive;
- aceptar integraciones mock que no respetan el contrato real;
- confundir “demo-ready” con “production-ready”.

En BenHouse, “hecho” significa:

FUNCIONAL
+
SEGURO
+
PROBADO
+
COHERENTE
+
OBSERVABLE
+
USABLE
+
ALINEADO CON BLUEPRINT

---

# 1. Estados de progreso

Utilizar tres estados conceptuales:

## VERDE

Bloque completado.

Cumple Definition of Done.

No tiene P0/P1 abiertos.

Puede servir de base al siguiente bloque.

## AMARILLO

Funciona parcialmente o tiene elementos pendientes relevantes.

Puede incluir:

- P1 abierto;
- integración incompleta;
- test faltante;
- UX incompleta;
- dependencia técnica pendiente.

No se considera cerrado.

## ROJO

Bloque roto, inseguro, incoherente o no implementado.

Puede contener:

- P0;
- flujo principal roto;
- seguridad crítica ausente;
- datos corruptibles;
- arquitectura contradicha.

No avanzar.

---

# 2. Regla principal

El objetivo de construcción de BenHouse v0.4 es:

ROJO
→ AMARILLO
→ VERDE

No saltar directamente a “terminado” porque una pantalla se vea bien.

---

# 3. P0

P0 es bloqueante absoluto.

Ejemplos:

- bypass de autenticación;
- acceso a documentación ajena;
- cross-organization leak;
- double payment;
- double incompatible Operation;
- firma por otra persona;
- Payment confirmado desde frontend;
- corrupción de datos;
- secrets expuestos;
- core journey inutilizable;
- migración destructiva no controlada.

Si existe P0:

bloque = ROJO.

No avanzar.

---

# 4. P1

P1 es problema importante que debe resolverse antes de cerrar el bloque.

Ejemplos:

- función aprobada no funciona;
- permisos incompletos;
- error recovery roto;
- filtro Search incorrecto;
- responsive crítico roto;
- integración sandbox no fiable;
- test importante ausente;
- requirement/transición incoherente;
- datos demo impiden flujo.

Si existe P1:

bloque no puede quedar VERDE.

---

# 5. P2

P2 es mejora no bloqueante.

Ejemplos:

- refinamiento visual;
- microcopy;
- optimización menor;
- animación;
- mejora de spacing;
- detalle no crítico.

Puede ir al backlog.

No usar P2 para esconder bugs reales.

---

# 6. Definition of Done de una funcionalidad

Una funcionalidad se considera terminada cuando cumple, si aplica:

1. alcance aprobado;
2. dominio correcto;
3. state machine correcta;
4. permisos backend;
5. DTO/input validation;
6. API contract;
7. persistencia;
8. eventos;
9. audit;
10. error handling;
11. tests positivos;
12. tests negativos;
13. responsive;
14. loading;
15. empty;
16. error;
17. accessibility básica;
18. observabilidad;
19. documentación necesaria;
20. sin P0/P1.

---

# 7. No basta con frontend

Ejemplo:

Botón “Hacer oferta” funciona visualmente.

Eso NO significa que Offer esté terminada.

Debe existir:

- API;
- permisos;
- estados;
- DB;
- revisions;
- events;
- concurrency;
- tests;
- Operation creation;
- error handling.

---

# 8. No basta con backend

Un endpoint funcional tampoco significa feature terminada si:

- UI no existe;
- UX es confusa;
- mobile falla;
- estados no se muestran;
- errores son técnicos.

Feature debe completar experiencia aprobada.

---

# 9. Definition of Done técnica

Todo bloque técnico debe tener:

- TypeScript sin errores;
- build correcto;
- lint aceptable;
- tests críticos verdes;
- migrations válidas;
- no secrets;
- no TODO críticos;
- errores gestionados;
- logs adecuados;
- dependency boundaries respetados.

---

# 10. TypeScript

No aceptar:

- errores de compilación;
- `any` indiscriminado en dominio crítico;
- casts para silenciar errores sin justificación.

Warnings razonables deben revisarse.

---

# 11. Build

Debe compilar:

- web;
- api;
- worker.

En el entorno correspondiente.

Un bloque no está verde si rompe build global.

---

# 12. Lint

Lint debe pasar según configuración.

No llenar código de:

- eslint-disable;
- ts-ignore;

para ocultar problemas.

Excepciones deben estar justificadas.

---

# 13. Tests

Los tests relevantes del bloque deben pasar.

Además:

regression suite relacionada no debe romperse.

No ejecutar únicamente test nuevo aislado.

---

# 14. Database

Cambios DB requieren:

- migration;
- constraints;
- indexes;
- relations;
- seed compatibility.

No usar cambios manuales no reproducibles.

---

# 15. Prisma

Schema debe:

- reflejar dominio aprobado;
- no duplicar conceptos;
- utilizar relaciones correctas;
- evitar cascadas destructivas peligrosas.

Antes de aprobar cambios relevantes:

review del schema/migration.

---

# 16. API

Cada endpoint terminado debe tener:

- DTO;
- validation;
- auth cuando corresponda;
- authorization;
- state validation;
- error contract;
- test;
- response projection.

---

# 17. Permissions

No se considera terminada una ruta privada si únicamente:

- UI oculta botón.

Backend debe rechazar actor no autorizado.

Debe existir test negativo cuando sea sensible.

---

# 18. State transitions

Toda transición crítica debe:

- usar command/action;
- validar estado;
- validar actor;
- ser atómica cuando corresponda;
- emitir evento;
- auditar si aplica.

No modificar status arbitrariamente.

---

# 19. Events

Cuando una acción requiera evento:

- persistido correctamente;
- outbox;
- handler idempotente;
- retry;
- error observable.

No aceptar “después añadiremos eventos” en bloques que ya dependen de ellos.

---

# 20. Worker

Jobs/handlers terminados deben:

- ser idempotentes;
- soportar retry;
- no saltarse dominio;
- registrar fallos;
- manejar reinicios.

---

# 21. Providers

Una integración se considera terminada si:

- utiliza Provider interface;
- adapter respeta contrato;
- errores normalizados;
- timeout;
- retry seguro;
- configuration;
- sandbox/mock;
- tests.

---

# 22. Mock providers

Mock no puede ser un shortcut inseguro.

Debe representar:

- success;
- failure;
- expiry;
- retry cuando corresponda.

No hacer simplemente:

`status = success`.

---

# 23. Webhooks

Webhook terminado requiere:

- signature verification;
- idempotency;
- providerEventId;
- state validation;
- test duplicate;
- test invalid signature;
- observability.

---

# 24. Payment

Payment solo queda VERDE si representa obligación y PaymentAttempt intentos externos múltiples; retries crean Attempts sin sobrescribir historial; providerReference vive en Attempt; backend controla amount/payer; idempotency y webhook duplicado son seguros; PaymentAttempt FAILED mantiene la obligación Payment recuperable y, si no existen Attempts activos y puede reintentarse, Payment vuelve a PENDING; el retry crea un PaymentAttempt nuevo. FAILED no es un estado de la obligación ante un fallo PSP reintentable. CONFIRMED actualiza Payment, Operation y Commission una sola vez; refund, 3 fallos+éxito, retry tras confirmado, IDOR y mass assignment están probados. No está terminado si un fallo obliga a reutilizar/reescribir un Attempt histórico.

Payment solo puede quedar VERDE si:

- amount backend;
- payer autorizado;
- sandbox;
- provider;
- webhook;
- idempotency;
- failure recovery;
- tests;
- Operation integration.

---

# 25. Signature

Signature solo VERDE si:

- signer correcto;
- provider/mock contract;
- webhook;
- multi-signature;
- failure;
- expiry;
- Contract integration;
- Operation integration;
- tests.

---

# 26. Documents

Document solo VERDE si:

- private storage;
- authorization;
- upload validation;
- signed access;
- status;
- rejection recovery;
- audit sensible;
- tests IDOR.

---

# 27. Verification

Verification solo VERDE si:

- provider/mock;
- states;
- authorization;
- no frontend VERIFIED;
- Trust integration;
- requirements;
- tests.

---

# 28. Search

Search solo VERDE si:

- filtros aprobados;
- pagination;
- list/map misma lógica;
- PostGIS;
- empty;
- invalid filters;
- performance aceptable;
- responsive;
- tests.

---

# 29. Map

Map solo VERDE si:

- Google Maps integrado;
- markers;
- viewport;
- selection;
- search sync;
- clustering;
- error fallback;
- responsive;
- no bloqueo del listado.

---

# 30. Intelligence

Intelligence solo VERDE si:

- estructurada;
- determinista;
- snapshots;
- comparables;
- demand;
- confidence;
- methodologyVersion;
- synthetic propagation;
- AI optional;
- tests.

No requiere perfección predictiva real para demo.

Sí requiere honestidad de datos.

---

# 31. Property detail

Solo VERDE si:

- gallery;
- price;
- data;
- CTAs;
- map;
- Intelligence;
- trust;
- availability cuando aplique;
- advertiser;
- responsive;
- loading/error;
- demo data correcta.

---

# 32. Favorite

VERDE:

- add/remove;
- idempotency;
- persistence;
- own access;
- UI state;
- price drop integration;
- tests.

---

# 33. Saved Search

VERDE:

- create;
- edit;
- disable/delete;
- criteria validation;
- matching;
- dedup notifications;
- own access.

---

# 34. Visits

VERDE:

- request;
- confirm;
- cancel;
- complete;
- no-show;
- reminders;
- permissions;
- state tests;
- responsive.

---

# 35. Messaging

VERDE:

- contextual conversation;
- participants;
- send;
- list;
- unread;
- IDOR protection;
- rate/length validation;
- responsive.

---

# 36. Offers

VERDE:

- create;
- revise;
- accept;
- reject;
- withdraw;
- expire;
- history;
- concurrency;
- Operation creation;
- rollback;
- tests.

---

# 37. Auctions

VERDE:

- schedule;
- active;
- bids;
- time rules;
- end job;
- winner validation;
- anonymity;
- concurrency;
- tests.

---

# 38. Operation

Operation es núcleo crítico.

Solo VERDE si:

- creation;
- participants;
- requirements;
- documents;
- contract;
- signatures;
- payment;
- cancellation;
- recovery;
- completion;
- history;
- events;
- tasks;
- activity;
- permissions;
- tests E2E.

---

# 39. Requirements

VERDE si:

- represent missing action;
- state;
- completion real;
- dependency handling;
- Tasks integration;
- Operation reevaluation.

---

# 40. Contracts

VERDE:

- template demo;
- generation;
- versioning;
- storage;
- signers;
- signature;
- signed preservation;
- demo disclaimer.

---

# 41. Commission

VERDE:

- configured rate;
- backend calculation;
- Payment/Operation relation;
- no frontend authority;
- history;
- tests.

No requiere fiscalidad definitiva.

---

# 42. Activity

VERDE:

- relevant projection;
- secure payload;
- timeline;
- integration with key events;
- own access.

---

# 43. Tasks

VERDE:

- actionable;
- correct assignee;
- auto completion when applicable;
- no fake completion;
- notification distinction.

---

# 44. Owner analytics

VERDE:

- views;
- favorites aggregate;
- contacts;
- visits;
- offers;
- own/managed listings only;
- no identity leakage.

---

# 45. CRM

VERDE:

- organization;
- portfolio;
- leads;
- assignment;
- notes;
- tasks;
- visits;
- offers;
- operations;
- dashboard;
- isolation tests.

No necesita CRM enterprise.

---

# 46. Investor experience

VERDE:

- Intelligence;
- zones;
- opportunities;
- saved listings;
- comparisons essential.

No finance enterprise.

---

# 47. Admin

VERDE:

- minimum critical operations;
- capability checks;
- audit;
- filters;
- secure access.

No necesita diseño premium completo.

---

# 48. Frontend states

Toda vista principal debe tener:

- loading;
- success;
- empty cuando aplique;
- error;
- permission denied;
- disabled;
- action feedback.

Una pantalla con solo success state no está verde.

---

# 49. Responsive

Feature no queda VERDE si su flujo crítico se rompe en mobile web.

Probar:

- desktop;
- tablet;
- mobile.

No requiere native app.

---

# 50. Accessibility

Mínimo:

- labels;
- focus;
- keyboard razonable;
- contrast;
- alt;
- semantic controls.

Un problema crítico de accesibilidad puede ser P1.

---

# 51. UX

Debe respetar `08-UX.md`.

No se aprueba feature funcional que:

- obliga a navegar por módulos técnicos;
- duplica flujos;
- rompe journey;
- crea saturación innecesaria.

---

# 52. Design System

Debe respetar `09-DESIGN-SYSTEM.md`.

No:

- colores aleatorios;
- nueva tipografía;
- dark mode;
- SaaS template;
- badges excesivos.

---

# 53. Copy

Todo texto visible de demo debe ser:

- español;
- claro;
- profesional;
- sin Lorem Ipsum;
- sin mensajes técnicos.

Anglicismos solo cuando estén aprobados como concepto.

---

# 54. Demo data

Feature no está demo-ready si depende de datos que no existen.

Debe tener:

- escenario;
- imágenes;
- estados;
- usuarios;
- fixtures.

---

# 55. DemoSynthetic

Toda Intelligence sintética debe indicarlo correctamente.

No aprobar una pantalla que presenta dato sintético como realidad comercial.

---

# 56. Error recovery

Cuando exista fallo recuperable, la feature no está terminada hasta que exista:

- mensaje;
- estado;
- siguiente acción;
- retry cuando corresponda.

Ejemplo:

PaymentAttempt FAILED
→ Reintentar.

---

# 57. Observability

Bloques críticos deben permitir saber:

- qué falló;
- requestId;
- eventId cuando corresponda;
- provider error class;
- worker status.

No aceptar fallos silenciosos.

---

# 58. Logging

Logs adecuados sin:

- secretos;
- passwords;
- document content;
- payment data.

---

# 59. Performance

Una feature puede ser funcional pero no verde si es inutilizable por rendimiento.

Search/Map especialmente.

Debe cumplir baseline medido y razonable.

---

# 60. No N+1 crítico

No cerrar Search/CRM/Activity/Operations con N+1 evidente que degrade el dataset demo.

---

# 61. Security

Se aplica `11-SECURITY.md`.

P0/P1 security impide VERDE.

No dejar security hardening principal para final.

---

# 62. Código limpio

No exigir perfección académica.

Pero evitar:

- controllers gigantes;
- duplicación masiva;
- lógica de negocio en UI;
- imports cruzados indebidos;
- componentes enormes;
- hacks sin documentar.

---

# 63. No overengineering

También puede impedir cierre si introduce riesgo innecesario.

No añadir:

- microservices;
- Kafka;
- Kubernetes;
- CQRS complejo;
- event sourcing;
- enterprise IAM;

sin necesidad.

La simplicidad correcta forma parte de Done.

---

# 64. Documentation

No documentar cada función trivial.

Sí documentar:

- decisiones;
- setup;
- env vars;
- commands;
- integrations;
- seed;
- architecture deviations;
- non-obvious rules.

---

# 65. Environment setup

Un desarrollador debe poder:

- instalar;
- configurar;
- ejecutar;
- migrate;
- seed;
- test.

Con documentación suficiente.

No depender de pasos secretos conocidos solo por quien construyó.

---

# 66. Local environment

Foundation no está verde hasta que:

- web;
- api;
- worker;
- PostgreSQL/PostGIS;

pueden arrancar correctamente.

---

# 67. Staging

Antes de demo externa:

debe existir un entorno staging/demo razonablemente estable.

No enseñar desde un entorno local frágil si se puede evitar.

---

# 68. Demo sandbox

Antes de demo:

- Payment = sandbox;
- Signature = sandbox/mock;
- Verification = sandbox/mock;
- synthetic data visible cuando corresponda.

No efectos reales.

---

# 69. Demo story usuario

BenHouse v0.4 no es demo-ready hasta completar:

Inicio
→ Search
→ Map
→ Property
→ Intelligence
→ Favorite
→ Visit
→ Offer
→ Accepted
→ Operation
→ Document
→ Contract
→ Signature
→ Payment
→ Completed
→ History

Sin tocar DB manualmente.

---

# 70. Demo story profesional

Debe completarse:

Professional login
→ Portfolio
→ Demand
→ Match
→ Lead
→ Conversation
→ Visit
→ Offer
→ Operation

---

# 71. Error recovery demo

Debe completarse:

Document rejected
→ correction
→ validated
→ signature
→ PaymentAttempt FAILED
→ retry
→ confirmed
→ completed

---

# 72. No manual rescue

Una demo no se considera válida si requiere:

- abrir Prisma Studio;
- ejecutar SQL manual;
- modificar status;
- reiniciar DB para continuar;
- editar datos a mano;
- usar endpoints inseguros.

---

# 73. Demo rehearsal

Antes de enseñar:

ejecutar todo desde reset conocido.

No asumir que porque funcionó ayer sigue funcionando.

---

# 74. Console quality

Antes de demo:

no debe existir flujo normal con:

- errores repetidos;
- unhandled promises;
- failed requests inexplicados;
- hydration errors;
- React warnings graves.

---

# 75. Visual quality

No dejar:

- imagen rota;
- placeholder técnico;
- contenido en inglés no aprobado;
- spacing roto;
- overflow;
- botón vacío;
- datos imposibles.

---

# 76. Critical browser support

Demo debe funcionar en navegadores modernos definidos en test plan.

Un fallo grave en Chrome/Edge/Safari moderno puede ser P1.

---

# 77. Git / commits

Cada bloque cerrado debe terminar con commit coherente.

Antes:

- test;
- review;
- no secrets;
- status limpio razonable.

---

# 78. Commit discipline

Commits deben explicar el cambio.

Evitar commits gigantes mezclando:

- auth;
- map;
- payment;
- CSS;
- refactor unrelated.

Construcción por bloques.

---

# 79. Build order

Orden oficial:

## A — Foundation

- monorepo;
- web;
- API;
- worker;
- DB;
- PostGIS;
- config;
- logging;
- testing base.

## B — Identity

- User;
- sessions;
- auth;
- Organizations;
- permissions foundation.

## C — Marketplace

- Property;
- Listing;
- Media;
- Location;
- Search;
- Map;
- Favorite;
- Saved Search.

## D — Intelligence

- demand;
- snapshots;
- comparables;
- opportunity;
- Match.

## E — Relationship

- Messaging;
- Visits;
- Activity;
- Notifications;
- Tasks.

## F — Transaction

- Offer;
- Auction;
- Operation;
- Requirements;
- Documents;
- Verification;
- Trust;
- Contract;
- Signature;
- Payment;
- Commission.

## G — Professional

- owner analytics;
- CRM;
- professional Intelligence;
- investor;
- Admin essentials.

## H — Polish

- UX;
- responsive;
- accessibility;
- performance;
- security review;
- demo data;
- E2E;
- stress;
- staging.

---

# 80. Gate entre bloques

Antes de pasar de un bloque al siguiente:

1. revisar cambios;
2. ejecutar build;
3. ejecutar tests;
4. revisar security;
5. clasificar bugs;
6. corregir P0/P1;
7. verificar DoD;
8. commit.

Solo entonces:

siguiente bloque.

---

# 81. Excepción de dependencia

Puede quedar algo AMARILLO únicamente cuando:

- depende estrictamente de bloque posterior;
- está documentado;
- no genera riesgo;
- no bloquea tests actuales;
- existe plan concreto.

No utilizar esto para acumular deuda.

---

# 82. Definition of Done de Block A — Foundation

VERDE cuando:

- monorepo arranca;
- web arranca;
- API arranca;
- worker arranca;
- PostgreSQL/PostGIS funciona;
- Prisma conecta;
- config validada;
- env example;
- logging;
- error handling base;
- lint;
- typecheck;
- tests base;
- Docker/local setup cuando se adopte;
- no secret fallback.

---

# 83. DoD Block B — Identity

VERDE cuando:

- register;
- login;
- logout;
- session;
- password reset;
- email verification;
- secure cookies;
- User;
- Organization;
- membership;
- permission policies base;
- IDOR tests;
- rate limiting;
- session revocation.

---

# 84. DoD Block C — Marketplace

VERDE cuando:

- Property;
- Listing;
- Media;
- Locations;
- PostGIS;
- Search;
- Map;
- filters;
- list/map sync;
- Favorites;
- Saved Searches;
- price history;
- responsive;
- demo data suficiente;
- authorization.

---

# 85. DoD Block D — Intelligence

VERDE cuando:

- demand data;
- MarketSnapshot;
- PropertyIntelligenceSnapshot;
- comparables;
- opportunity calculation;
- Match;
- confidence;
- methodology;
- demoSynthetic;
- Intelligence UI;
- map layer;
- AI optional fallback.

---

# 86. DoD Block E — Relationship

VERDE cuando:

- conversations;
- messages;
- visits;
- reminders;
- activity;
- notifications;
- tasks;
- permissions;
- states;
- responsive;
- events.

---

# 87. DoD Block F — Transaction

No cerrar parcialmente como “verde global”.

Debe completarse por subbloques y luego en conjunto.

VERDE cuando:

- Offer;
- revisions;
- Auction;
- Bid;
- Operation;
- Requirements;
- Documents;
- Verification;
- Trust;
- Contracts;
- Signatures;
- Payments;
- Commission;
- events;
- recovery;
- concurrency;
- idempotency;
- E2E transaction;
- no P0/P1.

---

# 88. DoD Block G — Professional

VERDE cuando:

- owner analytics;
- organizations;
- portfolio;
- leads;
- CRM notes/tasks;
- professional dashboard;
- demand;
- Match;
- investor essentials;
- Admin essentials;
- organization isolation.

---

# 89. DoD Block H — Polish

VERDE cuando:

- UX alignment;
- Design System;
- responsive;
- accessibility;
- performance;
- load/stress baseline;
- security review;
- demo seed;
- error states;
- empty states;
- browser QA;
- E2E;
- staging/demo;
- rehearsal.

---

# 90. Definition of Done global de v0.4

BenHouse v0.4 se considera DEMO-READY cuando:

- Blocks A–H están verdes;
- no existen P0;
- no existen P1;
- build pasa;
- typecheck pasa;
- tests críticos pasan;
- E2E principal pasa;
- demo reset funciona;
- datos demo son coherentes;
- sandbox está aislado;
- seguridad crítica está validada;
- journeys usuario/profesional/error recovery funcionan;
- UX parece producto real;
- performance es razonable;
- Blueprint está respetado.

---

# 91. Lo que DEMO-READY significa

Significa:

- se puede mostrar;
- se puede navegar;
- se puede probar;
- las funcionalidades aprobadas funcionan;
- los flujos transaccionales son sandbox;
- el sistema es coherente;
- la demo es reproducible.

No significa:

- dinero real;
- contratación legal real;
- compliance completo;
- escalado mundial;
- SLA;
- soporte 24/7.

---

# 92. Production-ready

Production-ready es una fase posterior.

Necesitará adicionalmente:

- revisión jurídica;
- GDPR/LOPDGDD;
- contratos definitivos;
- firma/eIDAS;
- PSP producción;
- KYC real si aplica;
- políticas;
- backups/restore;
- monitoring;
- security audit;
- incident response;
- legal retention;
- operational support;
- production infrastructure.

No bloquear demo por estas validaciones si sandbox está correctamente aislado.

---

# 93. Scope freeze

Durante v0.4:

una nueva idea no entra automáticamente.

Clasificar:

## P0
Necesaria para corregir integridad/seguridad.

## P1
Necesaria para completar funcionalidad ya aprobada.

## P2
Mejora.

## POST-V0.4
Nueva funcionalidad.

No ampliar silenciosamente.

---

# 94. Blueprint deviations

Si durante implementación una decisión necesita cambiar:

Codex debe:

1. detectar;
2. explicar;
3. clasificar;
4. indicar documento afectado;
5. proponer cambio mínimo;
6. no reinterpretar silenciosamente.

P0/P1 pueden justificar actualización del Blueprint.

---

# 95. Architecture guard

No se considera Done una solución que funcione pero contradiga:

- modular monolith;
- provider abstractions;
- outbox;
- PostGIS;
- backend authorization;
- state machines;
- scope.

La arquitectura forma parte de calidad.

---

# 96. UX guard

No se considera Done si técnicamente funciona pero rompe:

- journey;
- Mi BenHouse contextual;
- Operation integrada;
- property-first;
- mobile;
- Spanish UI;
- BenHouse visual identity.

---

# 97. Trust guard

No se considera Done si muestra:

- score opaco;
- datos sensibles;
- fraude;
- claims absolutos.

---

# 98. Intelligence guard

No se considera Done si:

- IA inventa métricas;
- synthetic aparece como real;
- confidence/metodología desaparecen;
- opportunity es flag arbitraria.

---

# 99. Transaction guard

No se considera Done si:

- Offer acceptance no es atómica;
- Payment se confirma por frontend;
- Signature se confirma por redirect;
- Document rejection cancela Operation;
- PaymentAttempt FAILED cancela Operation;
- historia se reescribe.

---

# 100. Demo integrity guard

No se considera demo-ready si para que parezca funcionar hay que:

- falsificar datos silenciosamente;
- marcar estados manualmente;
- ocultar errores;
- desactivar seguridad;
- utilizar dinero real;
- presentar synthetic como real.

---

# 101. Review obligatorio antes de cada verde

Checklist:

### Producto
- ¿cumple alcance?
- ¿cumple UX?

### Dominio
- ¿respeta entidades?
- ¿respeta states?

### Seguridad
- ¿auth?
- ¿permission?
- ¿IDOR?
- ¿input?

### Técnica
- ¿build?
- ¿tests?
- ¿events?
- ¿DB?

### UI
- ¿responsive?
- ¿loading/error/empty?
- ¿diseño?

### Operación
- ¿logs?
- ¿recovery?
- ¿provider failure?

---

# 102. Evidencia

No necesitamos burocracia pesada.

Pero el cierre debe basarse en evidencia.

Ejemplos:

- test results;
- build;
- screenshots;
- E2E;
- metrics;
- review notes.

No únicamente:

“parece que funciona”.

---

# 103. Lista de cierre final

Antes de declarar BenHouse v0.4 DEMO-READY:

1. Blueprint auditado.
2. Scope congelado.
3. Blocks A–H verdes.
4. 0 P0.
5. 0 P1.
6. Build verde.
7. Tests verdes.
8. Security tests verdes.
9. E2E usuario verde.
10. E2E profesional verde.
11. Error recovery verde.
12. Search/Map verde.
13. Intelligence verde.
14. Operation verde.
15. Providers sandbox verdes.
16. Demo seed reproducible.
17. Reset probado.
18. Responsive probado.
19. Browser QA.
20. Performance baseline.
21. No datos reales sensibles.
22. Synthetic etiquetado.
23. No secrets.
24. Staging estable.
25. Demo rehearsal completado.

---

# 104. Regla final

BenHouse v0.4 no se declara terminada porque:

“ya hay muchas cosas hechas”.

Se declara terminada cuando:

el alcance aprobado puede recorrerse de principio a fin con integridad, seguridad, calidad y coherencia.

Si existe un punto amarillo importante:

se corrige.

Si existe un punto rojo:

se bloquea.

El objetivo final es:

TODO VERDE.

---

# 105. Criterio de cierre del Blueprint

Después de completar este documento:

NO empieces a escribir código todavía.

Primero debe realizarse una auditoría transversal completa del Blueprint.

Auditar:

- `AGENTS.md`
- `00-VISION.md`
- `01-SCOPE.md`
- `02-ARCHITECTURE.md`
- `03-DOMAIN-MODEL.md`
- `04-STATE-MACHINES.md`
- `05-PERMISSIONS.md`
- `06-API-CONTRACTS.md`
- `07-EVENTS.md`
- `08-UX.md`
- `09-DESIGN-SYSTEM.md`
- `10-INTEGRATIONS.md`
- `11-SECURITY.md`
- `12-DEMO-DATA.md`
- `13-TEST-PLAN.md`
- `14-DEFINITION-OF-DONE.md`

Pero NO hagas todavía esa auditoría en esta tarea.
