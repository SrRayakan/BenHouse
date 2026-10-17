# C1.2 — Corrección de Sharp detenida en validación

Registro del intento detenido. La reanudación autorizada y sus resultados propios
se documentan en [C1-MEDIA-SHARP-REVALIDATION.md](C1-MEDIA-SHARP-REVALIDATION.md).

Ejecución propia: 16 de octubre de 2026. **Bloqueada; P1 no cerrado.**
La primera suite ejecutada falla. Se detiene la implementación y no se repite
ni se continúa la cadena, conforme a la instrucción expresa del usuario.
No hay staging, commit, push ni avance a C1.3.

## Punto de partida y cambios conservados

Se leyó primero `AUDITORIA-C1.2-RUSTFS.md`, además de AGENTS.md y los contratos
aplicables. Antes de editar se comprobaron los 49 archivos contra el inventario
SHA-256 final de aquella auditoría: rutas y bytes idénticos. Se conservó una
copia íntegra de esos archivos. Rama `main`, staging vacío, HEAD, origin/main
y referencia remota en `43d250bf0918925a9b3b790426d6b74473b5e149`;
remoto `https://github.com/SrRayakan/BenHouse.git`.

El cambio pendiente añade una barrera de firma/cabecera anterior a toda llamada
a Sharp: JPEG SOI y siguiente marcador; firma PNG e IHDR; RIFF/WEBP y primer
chunk permitido. La inspección inicial tiene posiciones fijas y exige como
máximo 33 bytes disponibles. No usa el nombre ni el Content-Type. Después se
conservan el recorrido acotado de chunks contra animación, la comprobación del
formato detectado, páginas, límites de tamaño y píxeles, y decodificación real.
El recorrido de chunks se adelanta también al decoder. Esta descripción del
código **no sustituye la demostración pendiente de la barrera**.

Sharp se fija en 0.35.5. El override limitado a `next>sharp` evita mantener la
0.34.5 permitida por Next. El diff del lockfile cambia Sharp, sus paquetes
binarios y sus resoluciones dependientes, incluido el peer opcional de tipos
de Node propagado a Next; no actualiza otras familias de dependencias.
La instalación con scripts deshabilitados terminó correctamente: +3/-3
paquetes locales. Se conservó la advertencia de ESLint 9.39.5 obsoleto.

Se agregan fixtures sintéticos benignos SVG, GIF, TIFF y AVIF, pruebas de entrada
al parser y cuatro casos HTTP adicionales para rechazo en carga y confirmación
sin Media READY. No se utilizaron cargas de explotación ni se demostró RCE.
No se modificaron el proveedor RustFS, el worker, el esquema ni las migraciones
en esta corrección.

## Dependencias y avisos consultados

Consulta de fuentes oficiales realizada el 16 de octubre de 2026:

- [GHSA-wq5f-xc86-pv6w](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w):
  afecta a Sharp anterior a 0.35.5; corrección con librsvg 2.63.2.
- [GHSA-rgj7-g3m4-5g8c](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c):
  corrección desde 0.35.4 y libheif 1.23.2.
- [GHSA-f88m-g3jw-g9cj](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj):
  su texto actualizado recomienda al menos 0.35.3 y libvips 8.18.3.
- [GHSA-54xq-cgqr-rpm3](https://github.com/lovell/sharp/security/advisories/GHSA-54xq-cgqr-rpm3)
  y [GHSA-gp95-ppv5-3jc5](https://github.com/lovell/sharp/security/advisories/GHSA-gp95-ppv5-3jc5):
  avisos históricos corregidos en versiones anteriores a la elegida.

La versión elegida queda fuera de los rangos afectados publicados en esos
avisos. No equivale a una auditoría de seguridad completa del árbol.
[Sharp 0.35.0](https://sharp.pixelplumbing.com/changelog/v0.35.0/) exige Node
20.9 o posterior, cambia la distribución y retira opciones obsoletas;
se usa Node 24.19.0 y `failOn`, no `failOnError`.
[Sharp 0.35.5](https://sharp.pixelplumbing.com/changelog/v0.35.5/)
incluye [binarios libvips 1.3.4](https://github.com/lovell/sharp-libvips/releases/tag/v1.3.4).

Comprobación propia del binario cargado en Windows x64:
Sharp 0.35.5, librsvg 2.63.2, libvips 8.18.7, libheif 1.23.5,
libpng 1.6.58, libtiff 4.7.2 y libwebp 1.6.0.
Storage y Next resuelven exactamente el mismo módulo instalado.
**Compatibilidad completa, tipos y build pendientes**, no aprobados por esta
comprobación. No se ensayaron los binarios de otros sistemas operativos.

## Resultados nuevos y motivo de parada

`pnpm --filter @benhouse/storage test`: **22 pasan / 4 fallan**, 26 pruebas,
dos archivos. Las 13 pruebas preexistentes pasan, incluidas imágenes estáticas,
APNG, WebP animado y GIF animado. En la suite nueva pasan nueve rechazos y
fallan los cuatro controles positivos del observador:

- JPEG, PNG y WebP válidos devuelven la metadata esperada, pero el spy registra
  cero llamadas en lugar de dos.
- El JPEG inválido con firma admitida es rechazado, pero el spy registra cero
  llamadas en lugar de una.

El observador no acredita que vea la instancia utilizada por `inspectImage`.
La causa concreta queda pendiente de investigación. Los nueve resultados
negativos **no prueban** que el parser no sea invocado: los controles positivos
detectan una medición inválida. No se rebajan aserciones ni se eliminan pruebas.
El P1 continúa abierto hasta corregir esa instrumentación y completar la cadena.

No ejecutados tras el fallo: unitarias del resto del monorepo, API, worker,
persistencia, integración del almacenamiento y aislamiento, cancelación y
limpieza por integración, lint, tipos, build, Prisma, upgrade y drift.
La cobertura HTTP nueva tampoco se presenta como aprobada. Las tres pruebas
recuperadas del worker permanecen en el código, pero **no se ejecutaron de nuevo**.
Los resultados de C1-MEDIA-OBJECTS-VALIDATION.md corresponden al código anterior
y no validan esta corrección.

Incidencia operativa anterior a la suite: el comando de escritura de formato
recibió una ruta inexistente `apps/api/src/modules/media/media.integration.test.ts`
y terminó con código 1. Se localizó el archivo real en `apps/api/src/media/` y
se formateó. No era un resultado de pruebas ni de comprobación de formato;
se registra para conservar el historial de errores.

## Protección histórica y residuos

Las huellas antes/después son byte a byte idénticas:
`83dd062abcfc165c6f737da8a9c49091f0ccb24aaa9c1f0e4f36b339bdc71cf9`.
Incluyen identidad, inventario de bases, configuración de protección,
migraciones y checksums, y hashes de filas con xmin de las tablas de aplicación.

- Sistema PostgreSQL `7681450735968391207`.
- `benhouse`: OID 16384, cinco migraciones, seis filas contabilizadas;
  `default_transaction_read_only=on` persistente conservado.
- `benhouse_test`: OID 79967, cinco migraciones, 20.282 filas contabilizadas.
  Las conexiones de lectura usaron modo solo lectura; no se afirma que esta
  segunda base tenga esa protección persistente.
- Único contenedor: `init-postgres-1`, ID histórico `e7b0e84a2d9b…`;
  único volumen: `init_benhouse-postgres-data`, conservado.

No se aplicó C1.2 a ninguna base histórica, no se habilitaron escritores ni se
crearon recursos Docker efímeros en esta corrección. No hubo nada propio que
eliminar. `.env` y backups históricos no se modificaron. Permanecen los cambios
sin staging, las dependencias instaladas, caches previas y los artefactos de
evidencia. No se limpiaron caches ni imágenes históricas.

Siguen abiertos los dos P2 de C1.1: detección de suites `.tsx`/`.jsx` y regresión
de geometría inválida de `Property.location_point`.

## Entrega para revisión del bloqueo

Evidencia local en
`C:/Users/Benja/.codex/visualizations/2026/10/13/01a13719-7eb0-70d2-adca-0227d9c8a4b6/c12-sharp/`:
`source-before/`, `tree-before.json`, `tree-after.json`, `git.json`,
`install.log`, `native-versions.json`, `storage-unit.log`, `before.json`,
`after.json`, `resources-after.json`, `c12-final.patch` y
`sharp-correction.patch`.
El primer patch entrega el diff completo contra HEAD, incluidos archivos nuevos;
el segundo, solo esta corrección contra los 49 archivos recibidos.
La entrega **no está lista para aprobación ni commit**. Requiere resolver la
prueba fallida, ejecutar toda la cadena sobre el código final y volver a
auditoría independiente.
