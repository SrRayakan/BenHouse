# C1.2 — Reanudación de la instrumentación de Sharp

Registro histórico. La siguiente reanudación autorizada está documentada en
[C1-MEDIA-HTTP-REVALIDATION.md](C1-MEDIA-HTTP-REVALIDATION.md).

Ejecución propia del 16 de octubre de 2026, posterior a
[C1-MEDIA-SHARP-VALIDATION.md](C1-MEDIA-SHARP-VALIDATION.md). Aquel informe y sus
cuatro fallos se conservan como historial. La reanudación fue autorizada
expresamente por el usuario. **Bloqueada por fallos en HTTP; no está lista para
aprobación ni commit.** Se detiene la cadena sin corregir ni repetir esa etapa.

## Punto de partida

Antes de editar se leyeron AGENTS.md, el informe del fallo y los contratos de
Media y almacenamiento. Los 52 archivos recibidos coinciden byte a byte con el
inventario de la entrega anterior; se copian a `source-before/`. `main`, HEAD,
origin/main y la consulta remota siguen en
`43d250bf0918925a9b3b790426d6b74473b5e149`. Staging vacío.
Remoto: `https://github.com/SrRayakan/BenHouse.git`.

Se leen las identidades y huellas históricas antes de la corrección. Docker solo
contiene el contenedor PostgreSQL histórico y su volumen al comenzar.

## Causa comprobada y corrección

La transformación de Vitest resuelve tanto la prueba como `image.ts` al mismo
`sharp/dist/index.mjs` de Sharp 0.35.5. No era una versión distinta ni un cambio
entre las entradas CommonJS y ESM. En la ejecución conjunta con `index.test.ts`,
`image.ts` conservaba en caché su referencia a Sharp real, cargada sin el mock.
El archivo de la prueba observaba otra función, creada por `vi.mock`.

La sonda de diagnóstico inspecciona también la función justo antes de la llamada
a `metadata`, sin modificar el archivo del repositorio. Resultado anterior:
`testMock=true`, `calledMock=false`, `calledSame=false`, `testCalls=0`.
Tras vaciar la caché antes de las importaciones: `calledMock=true`,
`calledSame=true`, `testCalls=2`, `imageCalls=2`, con metadata PNG real correcta.
Los IDs de resolución, transformaciones y resultados se conservan como evidencia.

La corrección añade `vi.hoisted(() => vi.resetModules())` antes de importar el
módulo bajo prueba. Es el mecanismo de
[reinicio de caché documentado por Vitest](https://vitest.dev/api/vi#vi-resetmodules).
No se confunde `clearAllMocks`, que borra contadores, con reevaluar módulos.
El wrapper continúa delegando en la implementación real de Sharp; no sustituye
metadata ni la decodificación por resultados simulados.

Se conservan las 13 pruebas de frontera, sin rebajar aserciones. Los cuatro
controles positivos se sitúan primero. JPEG, PNG y WebP deben producir metadata
real y exactamente dos llamadas con el mismo buffer; la firma JPEG con contenido
inválido debe producir una llamada y rechazo posterior. Solo con esos controles
válidos se interpreta la ausencia de llamadas de los nueve controles negativos.

La implementación de `inspectImage`, Sharp 0.35.5, su lockfile, los binarios,
el proveedor RustFS y los cambios anteriores de C1.2 se conservan. Esta
reanudación cambia instrumentación y documentación, no código de producción.

## Resultados propios

| Etapa | Resultado de esta ejecución |
| --- | --- |
| Controles positivos dirigidos | 4 pasan; después se ejecuta la suite completa |
| Almacenamiento unitario desde cero | 26/26, dos archivos |
| Prisma generate / validate | Ambos terminan con código 0; no migran bases |
| Build completo | Código 0, incluidos Next, API y worker |
| Lint / typecheck completos | Ambos terminan con código 0 |
| Unitarias del monorepo | 326 pasan; config 38, storage 26, database 43, API 212, worker 6, web 1 |
| API / HTTP | **218 pasan, 11 fallan y un error no manejado**, 229 pruebas en 13 archivos; código 1 |
| Worker integrado sin exclusiones | No ejecutado tras el fallo HTTP |
| Persistencia en cluster separado | No ejecutada tras el fallo HTTP |
| Objetos: integración, aislamiento y copia/restauración | No ejecutados tras el fallo HTTP |
| Upgrade y drift histórico | No ejecutados tras el fallo HTTP |

`packages/types` declara no tener suites y termina con código 0. Las seis
migraciones se aplicaron únicamente a la base API efímera; el caso de Media que
comprueba su schema y drift no figura entre los fallidos. Esto no sustituye la
validación pendiente de persistencia, upgrade y drift histórico.

Next regeneró su referencia en `next-env.d.ts`; se verificó que era el único
cambio del archivo y se restauraron los bytes iniciales antes del typecheck.
No se incluye ese cambio generado en el diff. Prisma mostró una sugerencia de
actualización a 8.0.0-rc.23; se conserva 6.19.1, sin actualizar dependencias.

Los cuatro controles positivos se ejecutan primero mediante un filtro temporal:
4 pasan y 9 no se seleccionan. Después se inicia un proceso nuevo para la suite
completa de almacenamiento: **26/26**, sin exclusiones. También pasa dentro de
las **326 unitarias** del monorepo. La selección inicial no representa cobertura
omitida en la ejecución completa.

La fase de diagnóstico no se cuenta como pruebas de aceptación. Una primera
sonda auxiliar falló por resolver el fixture desde el directorio equivocado
(`ENOENT`) antes de inspeccionarlo; se conserva su log y se corrigió la ruta.
Hubo además un intento malformado de invocación de herramienta que no ejecutó
código. Ninguno se oculta ni se presenta como una validación aprobada. La cadena
formal empieza con los cuatro controles positivos sobre la corrección final.

## Fallo que detiene esta reanudación

Diez pruebas de Media fallan al cargar el PNG sintético 1x1 compartido por los
helpers `uploaded` y `ready`, o al utilizar directamente ese mismo buffer.
Esperaban carga 200 (503 en el caso que simula fallo de storage), pero reciben
400 `MEDIA_INVALID_IMAGE`. No se alcanzan las aserciones posteriores de esas
pruebas: cancelación, confirmación, rollback, revocación y ordenación **no se
consideran validadas** por esta ejecución.

El diagnóstico limitado del fixture, sin repetir HTTP ni modificar bytes,
comprueba su CRC: IDAT almacena `4019903018`, pero el CRC calculado es
`4020414299`. IHDR e IEND sí coinciden. Sharp 0.35.5 rechaza ese buffer benigno
con `vipspng: libpng read error` durante la decodificación real. Por tanto, ese
fixture usado como imagen válida está corrupto. Se conserva sin corregir al
haber alcanzado la condición de parada del usuario. No se relaja la validación
de imagen ni se cambia `failOn` para admitirlo.

El undécimo fallo es la prueba heredada de expiración **absoluta** durante la
espera del lock de sesión, en `auth-persistence.integration.test.ts`: supera
el timeout de 5.000 ms. Vitest registra además un rechazo no manejado Prisma
`P2028`: `Unable to start a transaction in the given time`, asociado a ese
archivo y a esa última prueba. No se ha probado la causa subyacente del retraso;
no se declara intermitencia ni se aumenta el timeout para ocultarlo.

El resumen HTTP completo es 218/229 con 11 fallos y un error no manejado. Esa
ejecución no se presenta como aprobada, aunque los controles HTTP de formatos
ajenos, animación y los tres fixtures estáticos generados no figuren entre los
casos fallidos. Se conserva íntegro `api-integration.log`, incluida la advertencia
de Vitest sobre posibles falsos positivos por el error no manejado.

El runner devuelve código 1, limpia su base y los recursos de objetos propios,
y el ejecutor interrumpe la secuencia antes del worker. Las tres pruebas
recuperadas del worker siguen presentes, sin exclusiones añadidas, pero **no
se ejecutaron de nuevo**. No se usan resultados de turnos anteriores para cubrir
las etapas pendientes.

## Protección histórica y estado final

`before.json` y `after.json` son byte a byte idénticos, SHA-256:
`83dd062abcfc165c6f737da8a9c49091f0ccb24aaa9c1f0e4f36b339bdc71cf9`.
Se comparan inventario de bases, identidades, protección, cinco migraciones
históricas con checksums y hashes de filas de las tablas de aplicación con xmin.

- Sistema histórico `7681450735968391207`; `benhouse` OID 16384 y
  `benhouse_test` OID 79967. Las dos conservan sus cinco migraciones.
- `benhouse` conserva `default_transaction_read_only=on` persistente; no se
  habilitan escritores de aplicación. Ambas conexiones de comprobación usan
  modo solo lectura, sin atribuir esa protección persistente a `benhouse_test`.
- Base API propia `benhouse_api_7e465aaf680e4b2499a0b80fbb49e253_test`, OID
  281125, creada y eliminada por el runner con identidad verificada.
- Servicio y volumen RustFS propios
  `benhouse-c12-e01f755a-a0ef-4a92-ab40-ecc4c65de2b0` y su sufijo `-data`,
  eliminados junto con su red. El inventario final confirma que no quedan
  recursos Docker propios, aunque el runner no imprime su mensaje de éxito
  tras propagar el error de las pruebas.
- Único contenedor final: `init-postgres-1`, ID histórico `e7b0e84a2d9b…`;
  único volumen: `init_benhouse-postgres-data`. Ninguno se borró ni recreó.
- `.env` conserva su huella inicial. No se tocan backups históricos.

Se conservan los cambios de código recibidos, los artefactos de build y Prisma,
las dependencias y caches existentes y la evidencia de esta ejecución. No se
eliminan recursos ajenos. Los scripts de persistencia, drift y versiones copiados
para preparar las etapas siguientes no se presentan como ejecutados.

## Límites y pendientes

No se usaron cargas de explotación ni se ha demostrado RCE. Las pruebas de
frontera comprueban llamadas y contenido benigno real; no constituyen una prueba
de ausencia universal de vulnerabilidades nativas. Los avisos y versiones
corregidas consultados constan en el informe anterior. El entorno nativo ensayado
es Windows x64; no se certifican los binarios de todos los sistemas del lockfile.

Se mantiene el modelo de amenazas de RustFS: autenticación y loopback local;
el administrador de Docker/Windows y las credenciales de backend son fronteras
de confianza. No se afirma aislamiento frente al administrador del host.

Siguen abiertos ambos P2 de C1.1: detección de suites `.tsx`/`.jsx` y regresión
de geometría inválida de `Property.location_point`. No se implementa C1.3.

## Evidencia

Directorio de esta ejecución:
`C:/Users/Benja/.codex/visualizations/2026/10/13/01a13719-7eb0-70d2-adca-0227d9c8a4b6/c12-sharp-resume/`.
Incluye copia anterior, manifiestos, diagnóstico, logs propios y huellas.
Al cerrar se exportan `c12-final.patch` contra HEAD y `resume.patch` contra los
52 archivos recibidos. No se hace staging, commit ni push.
