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

## Instalación

```bash
pnpm install
```

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

## Validación

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```
