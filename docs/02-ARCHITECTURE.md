# BenHouse v0.4 — Arquitectura

## Objetivo

Definir la arquitectura técnica oficial de BenHouse v0.4. Este documento es vinculante para el MVP y debe impedir sobreingeniería, microservicios prematuros, duplicación de lógica, dependencias innecesarias, acoplamiento directo con proveedores externos y patrones heredados incompatibles con v0.4.

La prioridad es una base sólida, modular, segura, testeable y escalable, sin complejidad innecesaria antes de validar el producto.

## 1. Principio arquitectónico

BenHouse v0.4 utilizará un **monolito modular**. No se utilizará una arquitectura de microservicios.

La aplicación se dividirá por dominios funcionales y responsabilidades internas, desplegada inicialmente como un conjunto reducido de aplicaciones dentro de un monorepo. Podrán extraerse módulos hacia servicios independientes solo si la escala o las necesidades operativas lo justifican. No diseñar desde ahora para una escala hipotética.

## 2. Estructura general

La arquitectura objetivo será:

```text
BenHouse
├── Web (Next.js)
├── API (NestJS)
├── Worker (eventos, jobs y tareas en segundo plano)
├── PostgreSQL (Prisma y PostGIS)
├── Object Storage
├── Event/Outbox System
└── Integraciones externas mediante Providers
```

## 3. Monorepo

Estructura objetivo aproximada:

```text
apps/
  web/
  api/
  worker/
packages/
  ui/
  config/
  types/
  validation/
  domain-shared/
docs/
infrastructure/
```

No crear paquetes sin una necesidad real de reutilización entre aplicaciones ni convertir `packages/` en un almacén genérico.

## 4. Frontend

Tecnologías principales: Next.js, React, TypeScript y Tailwind CSS, con App Router. El frontend será responsive para escritorio, tablet y móvil web. No desarrollar aplicación móvil nativa en v0.4.

## 5. Responsabilidades del frontend

El frontend es responsable de representación visual, interacción, navegación, formularios, estado de interfaz, accesibilidad, loading, empty, success, error, permission denied, presentación contextual, sincronización de filtros y mapa, y experiencia responsive.

No es fuente de verdad de permisos, propiedad de recursos, estados críticos, importes o comisiones oficiales, validaciones de negocio, resultados de pago, firma o identidad ni transiciones de operación. El frontend solicita acciones; el backend decide si están permitidas.

## 6. API

Tecnologías principales: NestJS, TypeScript, Prisma y PostgreSQL. La API se organiza por módulos de dominio:

`auth`, `users`, `organizations`, `properties`, `listings`, `locations`, `media`, `search`, `intelligence`, `favorites`, `saved-searches`, `messaging`, `visits`, `offers`, `auctions`, `operations`, `requirements`, `documents`, `verification`, `trust`, `contracts`, `signatures`, `payments`, `commissions`, `notifications`, `tasks`, `activity`, `crm`, `analytics`, `audit` y `admin`.

No todos los módulos requieren la misma estructura interna: la organización responde al dominio y no a una plantilla mecánica.

## 7. Capas del backend

Cuando un dominio lo requiera, separar:

- **Controller**: HTTP, DTOs, autenticación contextual, serialización y códigos de respuesta; sin lógica de negocio relevante.
- **Application/Service**: casos de uso, coordinación, validaciones de aplicación, permisos, transacciones, llamadas a dominio y generación de eventos.
- **Domain**: reglas, estados, invariantes, transiciones y comportamiento independiente de infraestructura.
- **Infrastructure**: Prisma, almacenamiento, email, mapas, pagos, firma, KYC, IA y proveedores externos.

No introducir capas artificiales en módulos triviales; usarlas donde reduzcan acoplamiento y protejan reglas importantes.

## 8. Regla sobre Prisma

Los controllers no realizan directamente operaciones Prisma en casos de negocio complejos, especialmente ofertas, pujas, operaciones, pagos, contratos, firma, permisos, verificaciones, documentos y cambios de estado. Estas operaciones pasan por servicios de aplicación/dominio. Prisma es persistencia, no lógica de negocio.

## 9. Base de datos y PostGIS

La base de datos oficial es **PostgreSQL**, con **Prisma** como ORM y **PostGIS** como extensión geoespacial. PostgreSQL es la fuente principal de verdad del dominio transaccional. No usar MongoDB como base principal.

PostGIS resuelve, cuando corresponda, búsqueda por viewport, bounding box, polígonos, dibujo de zonas, proximidad, relación inmueble-zona e Intelligence geográfico. No reinventar en JavaScript cálculos geográficos que PostGIS pueda resolver fiablemente.

## 10. Identidad y autorización

No utilizar `un usuario = un rol`. Un usuario puede actuar como comprador, inquilino, propietario, inversor y miembro de una organización profesional. Las capacidades se deducen de identidad, relaciones, organización, permisos, estado y requisitos; los privilegios administrativos se separan de las capacidades normales.

Regla conceptual:

```text
IDENTIDAD + CAPACIDAD + RELACIÓN CON EL RECURSO + ESTADO DEL RECURSO + REQUISITOS = ACCIÓN PERMITIDA
```

Toda autorización crítica se comprueba de nuevo en backend. No confiar en botones ocultos ni en `userId`, `ownerId`, `fromUserId` u otros identificadores enviados por cliente para determinar la identidad autenticada.

## 11. Máquinas de estado, atomicidad e idempotencia

Listing, Visit, Offer, Auction, Document, Contract, Signature, Payment y Operation usan transiciones explícitas. No permitir estados críticos mediante `PATCH` genérico. Una acción crítica autentica, autoriza, valida estado y requisitos, ejecuta la transición, persiste, genera evento y audita.

Las transiciones críticas son atómicas mediante transacciones cuando exista riesgo de estados parciales o carreras: aceptar una oferta, seleccionar ganador válido, crear operación, confirmar pago, completar operación y actualizar dependencias.

La idempotencia es obligatoria en pagos, webhooks, creación de operaciones cuando corresponda, firma, acciones económicas y handlers de eventos críticos. Las claves deben tener alcance, expiración y almacenamiento adecuados.

## 12. Eventos, outbox y worker

Flujo conceptual:

```text
CAMBIO DE ESTADO → EVENTO → OUTBOX → WORKER → HANDLERS → NOTIFICACIÓN / TAREA / ANALYTICS / AUDITORÍA
```

No utilizar Kafka en v0.4. Los eventos críticos usan outbox transaccional cuando requieran consistencia; por ejemplo, aceptar oferta, crear operación y registrar evento se persisten coherentemente antes de que el worker procese el evento.

Existirá `apps/worker` para procesar outbox, enviar emails, recordatorios, alertas, expiración de ofertas, finalización de pujas, tareas programadas, recálculo de Intelligence y reintentos asíncronos permitidos. No esconder en el worker lógica crítica que deba ejecutarse síncronamente antes de confirmar la acción al usuario.

Los jobs se apoyarán inicialmente en PostgreSQL/outbox cuando sea suficiente. No introducir Redis ni infraestructura compleja de colas sin necesidad demostrada, aunque el mecanismo podrá sustituirse en el futuro.
