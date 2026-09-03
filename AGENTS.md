# BenHouse v0.4 — Constitución técnica del repositorio

## Propósito y autoridad

Este repositorio construye **BenHouse v0.4**. Este archivo define sus decisiones técnicas y de producto ya cerradas. Su objetivo es evitar la reintroducción de debates resueltos y la incorporación de alcance no autorizado.

- El idioma de producto, documentación y UX es **español**.
- Cada cambio importante debe respetar los documentos de `/docs` cuando existan.
- Si una instrucción futura contradice este archivo o los documentos aplicables de `/docs`, señalar la contradicción antes de modificar código.
- No reabrir decisiones cerradas salvo que exista una contradicción técnica demostrable.

## Filosofía de producto

BenHouse es un producto inmobiliario **premium, tecnológico, humano y minimalista**, orientado a cerrar operaciones, no solo a publicar anuncios.

- Competidores de referencia: **Idealista** y **Fotocasa**.
- No añadir funcionalidades por iniciativa propia.
- Toda funcionalidad nueva que no sea crítica pertenece al backlog posterior a v0.4.
- La fotografía inmobiliaria es protagonista.
- Evitar dashboards genéricos y el exceso de badges, puntuaciones o scores.

## Alcance cerrado de v0.4

- El frontend es una web responsive. No se construirá app móvil nativa en v0.4.
- Wallet visible: fuera de alcance.
- BenPoints: fuera de alcance.
- Marketplace gigante de profesionales: fuera de alcance.
- La IA generativa es opcional y secundaria. La lógica crítica debe ser determinista.

## Arquitectura base

- Arquitectura de repositorio: monorepo.
- Web: Next.js.
- API: NestJS.
- Persistencia: PostgreSQL, Prisma y PostGIS.
- Backend: modular monolith; no microservicios.
- Google Maps es el proveedor de mapas.
- `Property`, `Listing` y `Operation` son entidades separadas.
- Un usuario puede tener varias capacidades simultáneas: nunca modelar `one user = one role`.
- Intelligence debe integrarse en búsqueda, zonas, propiedades y decisiones; no debe existir como módulo aislado.

## Dominio, seguridad y consistencia

- El backend controla permisos, ownership, estados y transiciones.
- El frontend nunca decide estados críticos de negocio.
- Las acciones críticas deben usar servicios de dominio y transacciones.
- No usar `PATCH` genérico para transiciones críticas.
- La idempotencia es obligatoria en pagos, webhooks y toda acción económica o crítica.
- Usar eventos de dominio, outbox y worker para procesamiento asíncrono fiable.
- Mantener una auditoría inmutable de eventos importantes.
- No confiar en un `userId` enviado por el frontend para establecer la identidad.
- Usar sesiones seguras con cookies `HttpOnly`.
- No hardcodear secretos.
- La aplicación debe fallar al arrancar si faltan variables de entorno críticas.
- Configurar CORS explícitamente, rate limiting, validación de DTO, autorización por recurso, CSRF según la estrategia de sesión, validación de webhooks y límites de upload.
- Los documentos privados se almacenan en almacenamiento privado y se acceden solo mediante autorización y enlaces temporales.

## Proveedores e integraciones

- Los pagos se realizan a través de una abstracción `PaymentProvider`; v0.4 usa sandbox/test, nunca dinero real.
- La firma usa `SignatureProvider`; se permite sandbox o mock en v0.4.
- KYC usa `IdentityProvider`; se permite sandbox o mock en v0.4.
- `StorageProvider`, `EmailProvider`, `AIProvider` y `MapsProvider` son abstracciones obligatorias.
- El Intelligence Engine es determinista. La IA solo puede explicar resultados existentes; no puede inventarlos.

## Datos, UX y diseño

- Los datos demo deben marcarse explícitamente como sintéticos.
- Los seeds demo nunca se ejecutan automáticamente en producción.
- Estados obligatorios de UI: loading, success, empty, error y permission denied cuando aplique.
- Diseño: fondo blanco; verde y azul como colores funcionales principales; amarillo solo como acento limitado.
- Contratos, documentos, firma y pagos deben integrarse dentro del flujo de `Operation`.
- El CRM debe reutilizar entidades reales de BenHouse y no duplicar usuarios, propiedades, ofertas ni visitas.

## Calidad y entrega

- Son obligatorios tests unitarios, de integración y E2E para flujos críticos.
- Antes de considerar terminada una fase, deben pasar lint, typecheck, tests y build.

## Workflow obligatorio

1. Leer `AGENTS.md`.
2. Leer los documentos relevantes de `/docs`.
3. No programar fuera del alcance solicitado.
4. Implementar.
5. Ejecutar lint, typecheck, tests y build.
6. Revisar seguridad y efectos colaterales.
7. Informar de problemas encontrados.
8. No continuar con el siguiente bloque si hay P0/P1 sin resolver.
