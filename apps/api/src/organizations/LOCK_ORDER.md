# Orden de locks B1

Los conjuntos se bloquean siempre por UUID cuando una operación toma más de una fila del mismo tipo.

1. Identity: `User → PasswordCredential → Session → AccountToken`.
2. Organization: `Organization → OrganizationMember`.
3. Si un comando futuro necesita bloquear filas preexistentes de ambos dominios, Identity precede a Organization.

La creación B1.4 bloquea `User → Session` y revalida ambos antes de crear Organization y su primer OrganizationMember, que todavía no pueden estar bloqueados por otra transacción.

La edición bloquea y relee `User → Session → Organization → OrganizationMember`. Ningún dato mutable obtenido por la autenticación preliminar se usa como autorización final. Cada retry Serializable abre una transacción nueva y repite todos los locks y relecturas.

## Relación histórica en endpoints B1.4

Una membership `REVOKED` o `LEFT` concede cero capabilities y cero acceso mediante los endpoints B1.4, aunque la Organization esté `SUSPENDED` o `ARCHIVED`. Solo una membership `ACTIVE` permite la proyección mínima de una organización no activa. El histórico podrá exponerse en el futuro mediante un endpoint administrativo o de auditoría diseñado expresamente.
