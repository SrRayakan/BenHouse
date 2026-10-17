# C1.2 — Decisión técnica previa

**Registro histórico de la primera implementación.** La elección de filesystem
queda sustituida por [objetos locales aislados](C1-MEDIA-OBJECTS-DECISION.md)
tras la auditoría P1. No utilizar este documento como configuración vigente.

Fecha: 2026-10-13. Base verificada: `main`, HEAD/origin/main/remoto
`43d250bf0918925a9b3b790426d6b74473b5e149`, árbol y staging limpios.

Contratos aplicables: 01-SCOPE, 02-ARCHITECTURE, 03-DOMAIN-MODEL (Media),
05-PERMISSIONS (Property), 06-API-CONTRACTS (Media), 10-INTEGRATIONS
(24–30, 72), 11-SECURITY (28–33), 13-TEST-PLAN (50) y 14-DEFINITION-OF-DONE.

## Proveedor y autorizaciones

`StorageProvider` con implementación local de filesystem privado, compartida por
API y worker. Raíz absoluta explícita, fuera de directorios públicos, sin servidor
estático ni credenciales externas. PostgreSQL guarda exclusivamente metadatos.
El arranque con proveedor/raíz ausentes o inválidos falla cerrado.

La API local recibe bytes mediante PUT autorizado: URL relativa con ID de Media,
credencial opaca de 256 bits en cabecera, sesión y CSRF. La credencial se guarda
como hash; el cliente genera aleatoriamente `uploadToken` e `intentKey` antes de
crear la intención para poder reintentar una respuesta perdida sin generar otra
autorización. No contiene ni expone storageKey. Caduca a los 15 minutos, se vincula
a la sesión creadora y solo permite subir el objeto esperado. La comprobación de
PROPERTY_EDIT, sesión y estado se repite bajo locks al escribir y confirmar.
No se usa una URL bearer que siga funcionando después de revocar permisos.

JPEG, PNG y WebP estáticos, máximo técnico 10 MiB y 40 millones de píxeles.
Decodificación completa con sharp; MIME declarado y detectado deben coincidir.
No se admiten SVG, animaciones, vídeos ni documentos. Los límites son defensas
técnicas, no requisitos para publicar ni decisiones de C1.3.

## Ciclo de vida y consistencia

PENDING → READY únicamente tras verificar existencia, bytes, SHA-256, MIME y
recurso bajo autorización vigente. Objeto inmutable: una repetición con bytes
idénticos es idempotente; bytes distintos nunca sobrescriben. El temporal se
escribe y sincroniza antes de enlazar atómicamente el objeto final.

DELETE archiva READY conservando objeto y metadatos históricos. PENDING puede
cancelarse; ya no podrá completarse. No se define una retención destructiva para
fotos confirmadas. No hay publicación ni URL pública, tampoco preview público.
La lectura privada vuelve a autorizar PROPERTY_EDIT y devuelve no-store.

Orden total por Property con versión optimista y conjunto exacto de fotos READY;
locks en orden Identity → Organization → Property → PropertyAuthorization → Media.
Auditoría atómica con cada cambio. Los trabajos de limpieza se registran en outbox
en la misma transacción que crea/cancela la intención. El worker comprueba estado
y caducidad antes de borrar, de forma idempotente y reintentable.

Si filesystem completa y SQL revierte, el objeto sigue perteneciendo a una fila
PENDING ya persistida: reintento con el mismo contenido o limpieza al caducar.
No se escribe ningún archivo antes de persistir la intención. Temporales de
procesos interrumpidos se eliminan al limpiar esa intención, bajo el mismo lock.
Un rollback nunca hace visible una foto. No se ejecutan escritores contra benhouse.

## Validación y límites heredados

Migración aditiva, sin alterar migraciones históricas ni aplicar C1.2 a las bases
históricas. Pruebas HTTP/PostgreSQL en base efímera verificada, almacenamiento
temporal exclusivo, limpieza y comparación de huellas antes/después.

Siguen pendientes, sin atribuirles resolución en C1.2:

- P2 C1.1: detección de suites `.tsx`/`.jsx` en la barrera de integración.
- P2 C1.1: regresión de geometría inválida de `Property.location_point`.

Los informes C1.1 describen estados históricos: la instrucción actual confirma
que C1.1 ya está aplicada en ambas bases; se comprobará mediante lectura.
