# C1 aprobado — C1.1 Location Core

- **C1.1, este cambio:** ubicación territorial estructurada y asociación segura con Property.
- **C1.2, posterior:** medios/fotografías mediante StorageProvider y upload autorizado.
- **C1.3, posterior:** transición explícita `DRAFT → UNDER_REVIEW → PUBLISHED` y ficha pública responsive. UNDER_REVIEW es validación determinista del backend, nunca aprobación humana; no se publica desde DRAFT.

Búsqueda completa, autocomplete, mapa, favoritos, búsquedas guardadas y alertas quedan fuera de C1.1. No se implementan C1.2/C1.3, ni se añaden integraciones, claves, geocodificación o interfaz web.

## Modelo e integridad

`Location` es un nodo de catálogo identificado por UUID y código único estable, con nombre, tipo territorial, padre, centroide PostGIS opcional, marca `demoSynthetic` y timestamps. La jerarquía normalizada representa país, comunidad autónoma, provincia, municipio, distrito y barrio; no duplica estos nombres en cada inmueble. El código es un identificador del catálogo, no una afirmación de certificación oficial.

Solo COUNTRY puede ser raíz. El padre debe existir y tener un tipo anterior al hijo; la FK compuesta `(parentLocationId, parentKind) → (id, kind)` y el CHECK de orden impiden referencias falsas, ciclos y jerarquías invertidas, incluidas escrituras SQL concurrentes. Pueden omitirse niveles administrativos no aplicables. No hay endpoint de escritura de catálogo; su carga controlada y procedencia quedan para una tarea de datos autorizada. La migración no crea direcciones ni catálogo ficticio. Los fixtures se marcan sintéticos y se retiran al finalizar.

`Property.locationId` es opcional para compatibilidad; `locationVersion` empieza en 0. Dirección privada estructurada: `streetName`, `streetNumber`, `addressUnit`, `postalCode`. El número/unidad requieren vía. El código postal pertenece a la dirección: no se trata como nivel territorial ni se presume que sus límites coincidan con los de un municipio.

`Property.locationPoint` y `Location.centroid` son `geometry(Point,4326)` con índices GiST; se validan tipo, SRID, punto no vacío y rangos longitude [-180,180], latitude [-90,90]. El SQL usa longitud como X y latitud como Y. No se infiere una dirección desde coordenadas ni se afirma contención territorial sin polígonos de referencia. El centroide territorial no sustituye al punto privado de Property.

Migración aditiva `20261011000000_location_core`: sin reset, seeds, borrados, backfills de direcciones o modificaciones de Listing. Los registros previos conservan sus campos y reciben ubicación nula/versión 0.

## API mínima

| Ruta                           | Contrato                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| `GET /locations`               | Raíces; pública, `limit` 1–100 (50 por defecto), `offset` 0–10000.                      |
| `GET /locations/:id`           | Nodo territorial público por UUID.                                                      |
| `GET /locations/:id/children`  | Hijos directos con la misma paginación; padre inexistente → 404.                        |
| `GET /properties/:id/location` | Ubicación/dirección/punto privados y versión; sesión y PROPERTY_EDIT.                   |
| `PUT /properties/:id/location` | Reemplazo completo de ubicación; sesión, Origin, CSRF, PROPERTY_EDIT y Property ACTIVE. |

El catálogo proyecta solo `id`, `code`, `name`, `kind`, `parentLocationId`, `demoSynthetic`; no incluye propiedades inversas, direcciones o puntos privados. Orden estable por nombre/id y `[]` cuando no hay resultados.

Ejemplo conceptual de PUT (usar un UUID existente del catálogo):

```json
{
  "locationId": "01234567-89ab-4cde-8fab-0123456789ab",
  "expectedVersion": 0,
  "streetName": "Vía sintética de prueba",
  "streetNumber": "S/N",
  "coordinates": { "longitude": -1.25, "latitude": 2.5 }
}
```

`locationId` y `expectedVersion` son obligatorios. Los campos privados omitidos o nulos se limpian para no arrastrar una dirección/punto del lugar anterior. No se admite `locationId: null` ni se añade un comando de desvinculación. `expectedVersion` debe ser entero entre 0 y 2147483646; cada escritura confirmada incrementa la versión. Tras un conflicto 409, releer el recurso antes de editar. Un reintento con versión antigua no cambia datos ni duplica auditoría, aunque reutilice `X-Request-ID` (este identifica trazas, no sustituye la precondición de versión).

Se rechazan campos adicionales, UUID no canónico, números/coordenadas no finitos o fuera de rango, controles invisibles y textos vacíos/excesivos. No se aceptan padres/provincias independientes en el body: la cadena territorial se deriva de una sola referencia validada. 400 para entrada inválida; 401/403 para sesión/Origin/CSRF; 404 uniforme para recurso inexistente o sin permiso; 409 para versión obsoleta o Property archivada; 503 genérico ante dependencia/fallo transaccional.

## Permisos, privacidad y concurrencia

Se reutiliza la policy de Property existente: OWNER/MANAGER vigente individual, o membership activa en Organization activa con autorización suficiente sobre ese inmueble. Membership sola no basta; PUBLISHER no puede editar ni consultar dirección exacta. No se concede ningún bypass administrativo nuevo. La identidad se obtiene de la sesión y se revalida tras los bloqueos.

Orden existente: usuario/sesión → organizaciones/memberships ordenadas → Property → PropertyAuthorization → Location (KEY SHARE). Transacción serializable con reintentos acotados; versión bajo bloqueo impide pérdida de actualizaciones entre actores. Las revocaciones de permisos se revalidan antes de escribir. La auditoría `PROPERTY_LOCATION_SET` es atómica y registra solo la nueva versión, nunca dirección o coordenadas. No hay efectos asíncronos en este subbloque; no se emiten trabajos sin consumidor.

Las rutas de ubicación privada responden `Cache-Control: no-store`. Los DTO previos de Property/Listing siguen sin dirección exacta ni coordenadas; la futura proyección pública se definirá en C1.3 con allowlist explícita. La ubicación no cambia el estado de Listing.

## Validación y límites del cierre

Pruebas unitarias de entrada; PostgreSQL de FKs, jerarquía/ciclos, compatibilidad sin ubicación, restricciones de geometría e índices; HTTP real sobre Nest/PostgreSQL de rutas, permisos individuales/organizaciones, IDOR, CSRF/Origin, estados, privacidad, compare-and-set concurrente, revocación concurrente con bloqueo observado y rollback ante fallo de auditoría.

Los tests PostgreSQL nuevos usan transacciones siempre revertidas. La suite HTTP usa UUIDs propios, registra los IDs antes de insertar, verifica la base de test y limpia solo sus registros; el bypass temporal de inmutabilidad de auditoría se limita a su limpieza transaccional con IDs exactos y actores propios. No limpia residuos de suites antiguas.

Ver [evidencia de validación](C1-VALIDATION.md) para comandos, resultados y estado de las bases.

## Deudas heredadas separadas

Las deudas previas conservan su estado y alcance; C1.1 no las cierra ni las absorbe. En particular, los controles generales de la plataforma ajenos a estas rutas y los bloques de marketplace posteriores no se declaran completos por esta entrega. Los residuos históricos de las suites se conservan. C1.2/C1.3 son trabajo posterior aprobado, no implementación incluida en este diff.

La primera validación detectó un P1 heredado de aislamiento de las suites de identidad. El runner exclusivo corrigió el comando oficial, pero la auditoría independiente encontró un bypass al omitir la configuración de Vitest. La nueva barrera se importa desde cada suite antes de registrar hooks. El incidente anterior permanece registrado sin reconstruir datos: [evidencia anterior](C1-VALIDATION.md), [primer delta de aislamiento](C1-ISOLATION-VALIDATION.md) y [corrección del bypass](C1-GUARD-VALIDATION.md). La auditoría independiente debe reanudarse y completar la revisión funcional de Location que quedó interrumpida; esta corrección no la sustituye.
