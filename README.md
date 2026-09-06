# BenHouse v0.4

Monorepo de BenHouse v0.4, un producto inmobiliario premium orientado a cerrar operaciones.

## Estructura

- `apps/web`: aplicación web Next.js.
- `apps/api`: API NestJS.
- `apps/worker`: worker TypeScript para procesamiento futuro en segundo plano.
- `packages/config`: configuración compartida no sensible.
- `packages/types`: tipos compartidos mínimos.
- `docs`: Blueprint funcional y técnico congelado.

## Requisitos

- Node.js 24.19 o superior.
- pnpm 11.19 o superior.
- Docker Desktop o un runtime compatible con Docker Compose para PostgreSQL/PostGIS local.

## Instalación

```bash
pnpm install
```

## Persistencia local

1. Copia `.env.example` como `.env` y sustituye los valores locales si lo necesitas.
2. Arranca PostgreSQL con PostGIS, limitado a `localhost`:

```bash
pnpm db:up
```

3. Valida el schema, genera Prisma y aplica la migración de PostGIS:

```bash
pnpm db:validate
pnpm db:generate
pnpm db:migrate:deploy
```

`TEST_DATABASE_URL` debe apuntar a una base diferente de `DATABASE_URL`. Las pruebas de integración se niegan a ejecutarse si ambas URLs coinciden.

El runner de integración fuerza `NODE_ENV=test`, compara host, puerto efectivo y base de ambas URLs (sin considerar `schema`), exige una base terminada en `_test` y solo acepta los hosts definidos en `TEST_DATABASE_ALLOWED_HOSTS`. Estas barreras reducen errores de configuración, pero no resuelven alias DNS que puedan referir al mismo servidor ni comprueban roles, permisos o ACL reales. No sustituyen una base física y credenciales de test dedicadas: en CI, staging y cualquier entorno compartido deben usarse credenciales con mínimo privilegio y un destino físico dedicado.

Comandos útiles:

```bash
pnpm db:status
pnpm db:down
pnpm test:integration
```

El Compose incluido es exclusivamente para desarrollo y pruebas locales. No es una configuración de producción. No versionar `.env`, contraseñas reales ni datos del volumen local.

## Desarrollo

```bash
pnpm dev
```

También se pueden iniciar de forma independiente:

```bash
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

La web usa el puerto `3000`; la API, el `3001`. El worker no expone puerto.

La API ofrece:

- `GET http://localhost:3001/health`: liveness sin información interna.
- `GET http://localhost:3001/ready`: verifica Prisma y PostGIS sin exponer credenciales.

## Validación

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Troubleshooting mínimo

- Si `db:up` falla, confirma que Docker Desktop está iniciado y que `POSTGRES_PORT` no está ocupado.
- Si Prisma no conecta, revisa únicamente que `DATABASE_URL` apunte a la base local levantada; no copies la URL a logs ni incidencias.
- Si la API o el worker fallan al arrancar, revisa que las variables críticas de `.env` estén presentes y sean válidas.
