# BenHouse v0.4 — Datos Demo y Escenarios de Prueba

## Objetivo

Definir el dataset demo oficial de BenHouse v0.4 y los escenarios preparados para validar visual, funcional y técnicamente el MVP.

Este documento debe impedir:

- demos vacías;
- datos incoherentes;
- precios absurdos;
- métricas inventadas sin etiquetar;
- dependencia de datos externos inestables;
- probar únicamente el happy path;
- mezclar datos sintéticos con datos reales;
- no poder reproducir bugs por seeds no deterministas.

El entorno demo debe ser reproducible.

---

# 1. Principio general

BenHouse v0.4 necesita suficiente volumen y variedad para probar:

- búsqueda;
- filtros;
- mapa;
- PostGIS;
- Intelligence;
- favoritos;
- alertas;
- visitas;
- ofertas;
- pujas;
- operaciones;
- documentación;
- contratos;
- firma sandbox;
- pagos sandbox;
- CRM;
- analítica;
- confianza;
- estados de error.

No se necesita replicar un portal inmobiliario completo con cientos de miles de inmuebles.

---

# 2. Naturaleza de los datos

Los datos iniciales serán:

- sintéticos;
- generados;
- coherentes;
- claramente etiquetados.

Cuando corresponda:

`demoSynthetic = true`

Debe existir también:

- source;
- datasetVersion.

Nunca presentar datos sintéticos como datos reales de mercado.

---

# 3. Dataset versionado

Versión inicial:

`BENHOUSE_DEMO_V04`

El seed debe ser determinista.

Misma versión del seed debe producir el mismo dataset lógico.

Esto facilita:

- tests;
- debugging;
- screenshots;
- comparación;
- reproducción de errores.

---

# 4. Mercados demo

v0.4 utilizará inicialmente cinco mercados:

1. Alicante / Costa Blanca
2. Madrid
3. Barcelona
4. Valencia
5. Málaga

Estos mercados no representan el límite comercial de BenHouse.

Son escenarios de prueba.

---

# 5. Mercado principal demo

Alicante / Costa Blanca será el mercado más completo.

Debe incluir zonas como:

- Alicante;
- Torrevieja;
- Orihuela Costa;
- Punta Prima;
- Playa Flamenca;
- La Zenia;
- Campoamor;
- Guardamar;
- Santa Pola;
- Elche cuando aporte variedad.

Objetivo:

permitir una demo especialmente rica de:

- costa;
- alquiler;
- vacacional;
- inversión;
- demanda;
- Intelligence.

---

# 6. Volumen

Objetivo aproximado inicial:

entre 500 y 1.000 Listings demo.

El número exacto puede ajustarse según:

- rendimiento;
- tiempos de seed;
- utilidad de test.

No crear volumen inútil.

Debe existir suficiente densidad para:

- clustering;
- búsquedas;
- comparables;
- zonas;
- Intelligence.

---

# 7. Distribución orientativa

El dataset debe incluir:

## Venta
aproximadamente 40–50%

## Alquiler larga duración
aproximadamente 20–25%

## Vacacional
aproximadamente 15–20%

## Temporada
aproximadamente 5–10%

## Habitaciones
aproximadamente 5–10%

Los porcentajes son orientativos.

La coherencia del dataset es prioritaria.

---

# 8. Tipologías

Incluir variedad:

- piso;
- apartamento;
- casa;
- chalet;
- adosado;
- ático;
- estudio;
- dúplex;
- villa cuando corresponda.

No utilizar todas las tipologías en todas las zonas si no tiene sentido.

---

# 9. Rangos de precio

Los precios deben ser plausibles según:

- ciudad;
- zona;
- tipología;
- superficie;
- estado;
- proximidad al mar/centro cuando corresponda.

No generar:

- mansión en Madrid por 30.000 €;
- estudio en pueblo pequeño por 3 millones sin justificación.

Los rangos pueden ser sintéticos pero deben parecer realistas.

---

# 10. Características

Distribuir de forma coherente:

- habitaciones;
- baños;
- superficie;
- terraza;
- garaje;
- ascensor;
- piscina;
- jardín;
- aire acondicionado;
- vistas;
- orientación;
- planta;
- año de construcción.

No asignar todas las features a todos los inmuebles.

---

# 11. Coordenadas

Cada Property debe tener coordenadas coherentes.

Usar datos geográficos compatibles con:

- mapa;
- PostGIS;
- zona;
- ciudad;
- polygon/bbox.

No generar coordenadas fuera del área asociada.

---

# 12. Locations

Las propiedades deben asociarse a Locations estructuradas.

Jerarquía aproximada:

Country
→ Autonomous Community
→ Province
→ Municipality
→ District/Area
→ Neighborhood

No todas las jerarquías necesitan el mismo nivel de detalle.

---

# 13. Property vs Listing

Un conjunto de Properties debe tener más de un Listing histórico para probar:

- reentrada al mercado;
- cambios de modalidad;
- cambios de precio;
- histórico.

No todos.

La mayoría puede tener un Listing activo.

---

# 14. Price History

Crear ejemplos con:

- sin cambios;
- una bajada;
- varias bajadas;
- subida;
- reentrada con nuevo precio.

Esto permite probar:

- price-drop alert;
- charts/contexto;
- Activity;
- Intelligence.

---

# 15. Estado de Listings

Dataset debe contener:

- DRAFT;
- UNDER_REVIEW;
- PUBLISHED;
- PAUSED;
- RESERVED;
- IN_OPERATION;
- CLOSED;
- REJECTED;
- WITHDRAWN.

La demo pública prioriza PUBLISHED.

Los demás sirven para paneles y tests.

---

# 16. Fotografías

Para demo premium:

utilizar assets inmobiliarios de alta calidad y con derechos adecuados.

Para tests automatizados:

pueden utilizarse assets locales simples.

No depender de:

- URLs aleatorias;
- Picsum como experiencia demo final;
- imágenes que puedan desaparecer.

---

# 17. Assets

Preferencia:

estructura controlada de assets demo.

Ejemplo:

`demo-assets/properties/...`

o storage demo gestionado.

Las rutas exactas se definirán durante implementación.

---

# 18. Media variety

Algunos inmuebles deben tener:

- varias imágenes;
- plano;
- vídeo metadata cuando se pruebe.

No es necesario generar vídeos reales para todos.

---

# 19. Usuarios demo

Crear identidades demo claras.

Ejemplos conceptuales:

- María — compradora/inquilina;
- Carlos — propietario;
- Laura — profesional;
- Daniel — inversor;
- Admin Demo.

No utilizar datos personales reales.

---

# 20. Usuario multipropósito

Al menos una cuenta debe demostrar:

un mismo User puede:

- guardar propiedades;
- ser propietario de otra;
- participar en Operation;
- actuar como inversor.

Esto prueba el modelo multi-capacidad.

---

# 21. Organizations

Crear al menos:

2–4 agencias demo.

Ejemplo conceptual:

- CostaHome;
- Levante Properties;
- Madrid Centro Inmobiliaria;
- Málaga Living.

Los nombres pueden ajustarse.

No utilizar empresas reales si puede inducir confusión.

---

# 22. Organization Members

Cada agencia debe tener:

- OrganizationAdmin;
- uno o varios ProfessionalMember.

Debe existir al menos un miembro revocado/inactivo para testear permisos.

---

# 23. Leads

Crear Leads en distintos estados:

- NEW;
- CONTACTED;
- QUALIFIED;
- ACTIVE;
- CONVERTED;
- LOST.

Relacionarlos con:

- User;
- Listing;
- Organization;
- professional.

---

# 24. Favoritos

# 23.1 Ownership y publisher

- **A:** Carlos es `OWNER` de Property A y publica Listing A directamente (`publisherUserId = Carlos`).
- **B:** Carlos es OWNER de Property B; CostaHome es MANAGER+PUBLISHER; Laura es miembro ACTIVE. Listing B tiene publisherOrganization CostaHome y responsibleMember Laura.
- **C:** Daniel, de otra Organization, intenta publicar Property B y es rechazado.
- **D:** CostaHome pierde PUBLISHER sobre Property C con Listing publicado: nuevas acciones se rechazan y Listing pasa a estado seguro, preferiblemente `PAUSED`; histórico permanece.
- **E:** Laura deja CostaHome: Listing sigue siendo de CostaHome; Laura pierde permisos y otro miembro autorizado puede continuar.

Crear usuarios con:

- 0 favoritos;
- pocos favoritos;
- muchos favoritos.

Al menos algunos Listings favoritos deben:

- bajar de precio;
- cerrarse;
- volver al mercado.

---

# 25. Saved Searches

Ejemplos:

“Punta Prima alquiler hasta 1.500 €”

“Alicante compra 3 habitaciones”

“Madrid centro inversión”

“Vacacional Orihuela Costa agosto”

Cada una con criterios coherentes.

---

# 26. Demand Signals

Generar actividad histórica sintética.

Ejemplos:

- SEARCH_PERFORMED;
- PROPERTY_VIEWED;
- FAVORITE_ADDED;
- MESSAGE_SENT;
- VISIT_REQUESTED;
- OFFER_CREATED.

No generar ruido completamente aleatorio.

La actividad debe reflejar patrones.

---

# 27. Patrones de demanda

Algunas zonas deben tener:

- alta demanda;
- demanda media;
- demanda baja.

Ejemplo demo:

Punta Prima:
alta demanda de alquiler/vacacional.

Otra zona:
oferta elevada pero demanda media.

Esto permite Intelligence diferenciada.

---

# 28. Market Snapshots

Crear snapshots coherentes por:

- Location;
- transactionType;
- propertyType cuando proceda;
- periodo.

Campos:

- averagePrice;
- medianPrice;
- priceM2;
- supply;
- demandLevel;
- sampleSize;
- methodologyVersion;
- demoSynthetic.

---

# 29. Intelligence Snapshots

Crear propiedades con:

- precio competitivo;
- precio alineado;
- precio elevado;
- demanda alta;
- demanda media;
- confianza alta/media según comparables.

No todas las propiedades deben tener insight positivo.

---

# 30. Comparables

Los comparables deben ser razonables según:

- zona;
- tipología;
- superficie;
- habitaciones;
- estado comercial.

No seleccionar comparables completamente arbitrarios.

---

# 31. Opportunities

Las oportunidades se calculan.

No seedear una bandera fija:

`isOpportunity=true`

sin metodología.

El seed debe generar datos que hagan que algunas propiedades resulten oportunidades.

---

# 32. Match

Preparar ejemplos:

- Lead con 6 Listings compatibles;
- Listing con varios leads propios compatibles;
- demanda agregada relevante para una propiedad.

Las razones de Match deben ser explicables.

---

# 33. Conversations

Crear:

- conversaciones activas;
- sin mensajes;
- con varios mensajes;
- vinculadas a Listing;
- vinculadas a Operation.

No utilizar conversaciones ajenas para mostrar al usuario incorrecto.

---

# 34. Messages

Texto demo en español.

Natural y breve.

Ejemplo:

“Hola, ¿sería posible visitar el piso el jueves por la tarde?”

Evitar Lorem Ipsum.

---

# 35. Visits

Preparar escenarios:

- REQUESTED;
- CONFIRMED;
- COMPLETED;
- CANCELLED;
- NO_SHOW.

Fechas relativas al entorno demo deben ser reproducibles o generadas de forma controlada.

Si se utilizan fechas dinámicas:

mantener fixtures/test deterministas.

---

# 36. Visit reminder scenario

Debe existir al menos una visita:

- CONFIRMED;
- próxima;
- con reminder pendiente.

Y otra:

- CANCELLED antes del reminder.

Test esperado:

no enviar reminder de la cancelada.

---

# 37. Offers

Crear:

- DRAFT;
- SENT;
- RECEIVED;
- UNDER_NEGOTIATION;
- ACCEPTED;
- REJECTED;
- WITHDRAWN;
- EXPIRED.

---

# 38. Offer Revision

Ejemplo de negociación:

Listing:
300.000 €

Buyer:
280.000 €

Seller:
290.000 €

Buyer:
285.000 €

Conservar todas las revisiones.

---

# 39. Price-change + Offer

Escenario obligatorio:

Listing:
300.000 €

Offer:
280.000 €

Listing baja:
290.000 €

Expected:

Offer sigue en 280.000 €.

---

# 40. Multiple Offers

Listing con:

- Offer A;
- Offer B;
- Offer C.

Preparar test donde:

se intenta aceptar A y B de manera concurrente.

Expected:

solo una Operation compatible.

---

# 41. Auctions

Crear:

- SCHEDULED;
- ACTIVE;
- ENDED;
- WINNER_PENDING_VALIDATION;
- WINNER_VALIDATED;
- CANCELLED.

---

# 42. Bids

Auction activa con varias bids.

No exponer identidades públicamente.

Preparar:

- bid válida;
- outbid;
- selected;
- invalid.

---

# 43. Auction failure

Escenario:

ganador candidato no supera requisito.

Expected:

- no Operation completada;
- siguiente candidato si reglas lo permiten;
- o Auction cerrada.

---

# 44. Operations

Crear operaciones preconfiguradas en diferentes estados.

Mínimo:

## Operation A
CREATED / REQUIREMENTS_PENDING

## Operation B
DOCUMENTS_PENDING

## Operation C
DOCUMENTS_UNDER_REVIEW

## Operation D
SIGNATURE_PENDING

## Operation E
PAYMENT_PENDING

## Operation F
PAYMENT_PROCESSING

## Operation G
COMPLETED

## Operation H
CANCELLED

---

# 45. Operation participants

Compra: Offer aceptada 285.000 € crea Operation OFFER/sourceOffer, María BUYER, Carlos SELLER y CostaHome AGENCY cuando corresponda. Alquiler usa TENANT/LANDLORD/AGENCY. Auction usa AUCTION/sourceAuction y conserva Bid seleccionada en Auction. Reintentos producen una sola Operation; revocar membership conserva historial y quita permisos futuros.

Incluir:

- buyer/seller;
- tenant/landlord;
- agency;
- professional.

No añadir participantes arbitrarios.

---

# 46. Requirements

Preparar:

- completed;
- pending;
- failed;
- waived;
- expired.

Algunas Operations deben mostrar:

“Te faltan 2 pasos”.

---

# 47. Documents

Crear metadata demo para:

- identidad;
- documento de propiedad;
- contrato;
- otros requisitos aprobados.

Estados:

- REQUESTED;
- UPLOADED;
- UNDER_REVIEW;
- VALIDATED;
- REJECTED;
- EXPIRED.

---

# 48. Document rejection

Escenario:

documento REJECTED con motivo:

“Imagen incompleta / documento no legible.”

Expected:

- Task de corrección;
- Requirement pendiente;
- Operation no cancelada.

---

# 49. Private documents

Escenarios: DNI familia X V1 REJECTED por imagen incompleta, V2 supersede V1 y VALIDATED; V1/V2 rechazadas y V3 validada. Reviewer recibe grant REVIEW de V2 con expiración; Seller participante sin grant no accede; grant revocado rechaza descarga; grant V1 no habilita V2.

No utilizar documentos personales reales.

Fixtures pueden utilizar PDFs/textos ficticios claramente demo.

---

# 50. Verification

Preparar:

- PENDING;
- IN_PROGRESS;
- VERIFIED;
- FAILED;
- EXPIRED;
- REVOKED.

Subjects:

- User;
- Property;
- Organization.

---

# 51. Trust Evidence

Generar evidencias coherentes:

- identity verified;
- property verified;
- operation completed;
- visit completed;
- issue.

No generar score público arbitrario.

---

# 52. Contracts

Crear contratos demo en:

- PREPARATION;
- GENERATED;
- SENT;
- SIGNATURE_PENDING;
- PARTIALLY_SIGNED;
- SIGNED;
- COMPLETED;
- SUPERSEDED.

---

# 53. Contract content

Todo contrato demo debe indicar claramente:

“Documento de demostración — sin validez jurídica.”

No utilizar contratos reales/copias sin validación legal.

---

# 54. Signatures

Preparar:

- PENDING;
- REQUESTED;
- SIGNED;
- FAILED;
- DECLINED;
- EXPIRED.

---

# 55. Signature sandbox scenario

Operation con dos firmantes:

Firmante A:
SIGNED

Firmante B:
PENDING

Expected:

Contract:
PARTIALLY_SIGNED

Operation:
SIGNATURE_PENDING

---

# 56. Payments

Escenario: una obligación de 6.000 € con tres Attempts FAILED y cuarto CONFIRMED; una sola Payment, sin cancelación de Operation ni duplicación por webhook/idempotency.

Preparar:

## Payment

- PENDING;
- IN_PROGRESS;
- CONFIRMED;
- CANCELLED;
- REFUND_PENDING;
- REFUNDED.

## PaymentAttempt

- INITIATED;
- PROCESSING;
- CONFIRMED;
- FAILED;
- CANCELLED.

Siempre sandbox/demo.

---

# 57. Payment failure scenario

Operation:
PAYMENT_PENDING

Payment:
PENDING

PaymentAttempt:
FAILED

Expected:

- Operation sigue abierta;
- Task “Reintentar pago”;
- Activity;
- no cancelación automática.
- nuevo retry crea otro PaymentAttempt.

---

# 58. Duplicate Payment Webhook

Fixture:

mismo providerEventId enviado dos veces.

Expected:

un solo efecto lógico.

No duplicar:

- Payment;
- Commission;
- Operation transition.

---

# 59. Commissions

Crear ejemplos con rate configurable:

2%.

Ejemplo:

Operation:
300.000 €

Commission:
6.000 €

Marcar como demo.

No representar tratamiento fiscal definitivo.

---

# 60. Activity

Preparar timeline con:

- price drop;
- visit;
- document validation;
- offer;
- contract;
- payment;
- operation completed.

Todo en español.

---

# 61. Notifications

Estados:

- unread;
- read;
- failed email/in-app scenario cuando corresponda.

---

# 62. Tasks

Ejemplos:

- completar verificación;
- subir documento;
- corregir documento;
- firmar contrato;
- reintentar pago.

También tasks completadas automáticamente.

---

# 63. Issues

Crear:

- OPEN;
- UNDER_REVIEW;
- RESOLVED;
- DISMISSED.

No incluir contenido sensible real.

---

# 64. Owner analytics

Crear suficiente AnalyticsEvent para demostrar:

Listing A

- 1.284 views;
- 43 favorites;
- 12 contacts;
- 6 visits;
- 2 offers.

Estas cifras son sintéticas.

---

# 65. Professional dashboard

Agency demo debe tener:

- cartera;
- leads;
- upcoming visits;
- active offers;
- active operations;
- demand signals;
- matches;
- property performance.

---

# 66. Investor demo

Preparar usuario inversor con:

- saved properties;
- zone comparisons;
- opportunities;
- Intelligence.

No cartera financiera avanzada.

---

# 67. Admin demo

Admin necesita recursos para revisar:

- verification pending;
- document pending;
- Listing under review;
- issue open;
- operation active;
- PaymentAttempt FAILED.

No utilizar Admin como demo principal comercial.

---

# 68. Empty states

Necesitamos usuarios/escenarios que permitan probar:

- 0 favorites;
- 0 visits;
- 0 operations;
- 0 search results;
- no messages.

---

# 69. Error states

Fixtures o mecanismos controlados deben permitir simular:

- provider timeout;
- payment failure;
- signature failure;
- KYC failure;
- storage error;
- email failure;
- AI unavailable.

No necesitan todos persistirse en seed si mock provider puede activarlos determinísticamente.

---

# 70. AI demo

Intelligence estructurada debe existir sin AI.

Cuando AI esté activa:

generar explicación basada en datos.

Cuando AI esté desactivada:

misma pantalla sigue funcionando.

---

# 71. Maps demo

Las coordenadas deben permitir:

- zoom;
- clusters;
- bbox;
- polygon;
- move map search;
- zone intelligence.

Alicante/Costa Blanca debe tener mayor densidad.

---

# 72. Polygon demo

Preparar test conocido:

polígono alrededor de Punta Prima.

Expected:

conjunto estable de Listings.

Esto permite regression test PostGIS.

---

# 73. Search scenarios

# 72.1 Escenarios de disponibilidad

**Availability A — Vacacional:** Listing de Punta Prima: 1–10 agosto `OCCUPIED`, 10–20 agosto `AVAILABLE`, 20–25 agosto `BLOCKED`.

**Availability B — Solapamiento:** ante `OCCUPIED` 10–20 agosto, crear ocupación 15–18 agosto debe rechazarse.

**Availability C — Checkout/checkin:** ocupaciones 10–20 y 20–25 agosto son válidas por `[start, end)`.

**Availability D — Habitaciones:** Room 1 `AVAILABLE` y Room 2 `OCCUPIED` en el mismo rango; Room 1 sigue disponible.

**Availability E — Cancelación:** una Operation genera `OCCUPIED`; al cancelarse deja de bloquear según regla explícita y conserva trazabilidad.

Crear queries esperadas.

Ejemplo:

## Scenario S1

Alicante
Venta
≤ 300.000 €
≥ 2 habitaciones

Debe devolver resultados.

## Scenario S2

Punta Prima
Alquiler vacacional
fechas determinadas

Debe devolver disponibilidad.

## Scenario S3

Madrid
Compra
3 habitaciones
garaje

Debe devolver conjunto reproducible.

## Scenario S4

Filtros imposibles

Debe devolver empty state.

---

# 74. Demo Story A — Usuario

Cuenta:

María.

Flujo preparado:

1. login/register;
2. busca Alicante;
3. explora Punta Prima;
4. Intelligence;
5. abre Listing;
6. Favorite;
7. price drop;
8. Visit;
9. Offer;
10. accepted;
11. Operation;
12. Documents;
13. Contract;
14. Signature sandbox;
15. Payment sandbox;
16. Completed;
17. History.

Debe poder ejecutarse sin modificar DB manualmente.

---

# 75. Demo Story B — Profesional

Cuenta:

Laura / agencia demo.

Flujo:

1. login;
2. portfolio;
3. demand;
4. Match;
5. Lead;
6. Conversation;
7. Visit;
8. Offer;
9. Operation;
10. analytics.

---

# 76. Demo Story C — Error recovery

Preparar una historia secundaria:

1. Operation activa;
2. Document rejected;
3. usuario corrige;
4. Document validated;
5. firma;
6. Payment fails;
7. retry;
8. Payment confirmed;
9. Operation completed.

Esto demuestra resiliencia.

---

# 77. Fechas demo

Evitar seeds que envejecen mal.

Dos estrategias:

## Fixtures estáticos
para tests exactos.

## Demo seed relativo
genera fechas respecto al momento de seed.

Ejemplo:

visit tomorrow.

La estrategia concreta debe separar:

- test determinista;
- demo visual actual.

---

# 78. Contraseñas demo

Solo local/staging.

Nunca production.

Pueden configurarse por entorno.

No hardcodear secretos reales.

Si existen credenciales demo conocidas:

entorno claramente aislado.

---

# 79. Seed commands

Separar conceptualmente:

- `seed:test`
- `seed:demo`
- `seed:dev`

Los nombres finales pueden variar.

No ejecutar automáticamente en production.

---

# 80. Seed idempotency

Idealmente:

reseed debe poder:

- limpiar dataset demo;
- recrear;

de forma controlada.

No destruir DB production.

Debe existir protección por entorno.

---

# 81. Production safety

Antes de ejecutar seed demo:

comprobar entorno.

Si environment = production:

abortar.

No ofrecer `--force` trivial que pueda destruir datos reales sin protecciones.

---

# 82. Data factories

Utilizar factories/helpers para crear:

- User;
- Property;
- Listing;
- Operation;
- etc.

No escribir 1.000 inserts manualmente.

Factories deben respetar invariantes.

---

# 83. Randomness

Si se usa random:

seed deterministic.

No depender de `Math.random()` sin seed para dataset principal.

---

# 84. Test fixtures

Tests críticos deben utilizar fixtures pequeños y explícitos cuando sea mejor.

No cargar 1.000 Listings para cada unit test.

Separar:

- demo dataset;
- integration fixtures;
- unit fixtures.

---

# 85. Performance dataset

Además del demo normal, debe poder generarse un dataset de carga mayor.

Ejemplo:

10.000+ Listings.

Solo para performance/load testing.

No forma parte del demo estándar.

Puede ser comando específico.

---

# 86. Search load

Performance dataset debe permitir probar:

- pagination;
- filters;
- PostGIS;
- map projection;
- clustering strategy;
- DB indexes.

---

# 87. Privacy

No utilizar:

- nombres reales identificables sin permiso;
- emails reales;
- teléfonos reales;
- DNI reales;
- direcciones privadas reales vinculadas a personas.

Las ubicaciones pueden ser geográficas reales, pero los inmuebles/personas son demo.

---

# 88. Direcciones

Para demo pública:

pueden utilizarse:

- direcciones ficticias plausibles;
- ubicaciones aproximadas;
- calles públicas sin asociarlas a personas.

Evitar afirmar que un inmueble demo real está actualmente en venta.

---

# 89. Data labeling

UI staging/demo debe poder indicar:

“Datos de demostración”

en contextos de Intelligence y operaciones sandbox.

No necesariamente mostrar un banner enorme en cada Property.

---

# 90. Data quality checks

Tras seed:

ejecutar validaciones.

Ejemplos:

- Listing sin Property;
- coordenada fuera de Location;
- negative price;
- room count imposible;
- active Listing sin price;
- Operation sin participants;
- Contract sin Operation;
- Payment sin Operation;
- Favorite duplicado.

Seed debe fallar si viola invariantes críticas.

---

# 91. Intelligence quality checks

Verificar:

- sampleSize > 0;
- comparables plausibles;
- confidence coherente;
- no NaN;
- no division by zero;
- synthetic flag propagada;
- methodologyVersion presente.

---

# 92. Visual quality checks

Demo no debe contener:

- imágenes rotas;
- placeholder técnico;
- “Lorem Ipsum”;
- nombres de variables;
- timestamps sin formato;
- textos en inglés innecesarios.

---

# 93. Demo reset

Debe existir forma segura de resetear staging demo.

Uso:

- demos;
- tests;
- recuperar estado conocido.

No incluir producción en reset.

---

# 94. Scenario presets

Puede existir mecanismo de fixtures/presets para mover rápidamente demo a:

- documents pending;
- signature pending;
- PaymentAttempt FAILED;
- operation completed.

Preferencia:

datos precreados.

No crear shortcuts inseguros dentro del producto público.

---

# 95. Sandbox providers

Mock providers deben poder asociar ciertos valores/fixtures a resultados.

Ejemplo:

Payment method demo A
→ success

Payment method demo B
→ failure

El mecanismo concreto depende del provider.

No exponer controles técnicos en UX production.

---

# 96. Screenshots/demo reproducibility

El dataset debe permitir que:

- mismas Properties;
- mismas imágenes;
- mismas zonas;
- mismos nombres;

aparezcan tras reset.

Esto ayuda a material comercial y QA.

---

# 97. Dataset documentation

El comando de seed debe documentar:

- qué crea;
- cuentas;
- escenarios;
- restricciones;
- cómo resetear;
- cómo identificar synthetic data.

No incluir passwords secrets en documentación pública.

---

# 98. Definition of demo-ready data

Dataset demo está listo cuando:

- Search tiene densidad;
- Map tiene clusters;
- Intelligence tiene contraste;
- owner tiene analytics;
- professional tiene CRM;
- Operation tiene todos los estados;
- error recovery puede demostrarse;
- no hay datos absurdos;
- assets funcionan;
- synthetic está identificado.

---

# 99. Lo que NO se necesita

No necesitamos para v0.4:

- scraping masivo;
- feeds reales de Idealista/Fotocasa;
- datos propietarios externos sin licencia;
- centenares de miles de anuncios;
- datos fiscales reales;
- información personal real;
- contratos legales reales;
- pagos reales.

---

# 100. Criterio de cierre

Los datos demo se consideran correctamente definidos cuando permiten probar y demostrar:

1. Search;
2. Map;
3. Intelligence;
4. zone pages;
5. Favorites;
6. price drop;
7. Saved Search;
8. Visits;
9. Messaging;
10. Offers;
11. Negotiation;
12. Auctions;
13. Operations;
14. Documents;
15. Verification;
16. Trust;
17. Contracts;
18. Signatures;
19. Payments;
20. Commissions;
21. Activity;
22. Tasks;
23. Owner analytics;
24. CRM;
25. Investor;
26. Admin;
27. empty states;
28. error recovery;
29. permissions;
30. performance baseline.
