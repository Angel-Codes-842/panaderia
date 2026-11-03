# Despliegue local en Docker (Windows 11)

El sistema usa Express y PostgreSQL en contenedores. La configuración por defecto limita el consumo para una notebook con 8 GB de RAM; los datos de PostgreSQL quedan en un volumen administrado por Docker.

## 1) Preparar variables de entorno

Copia la plantilla y editá los valores:

```powershell
Copy-Item .env.example .env
notepad .env
```

Antes del primer arranque, completá las contraseñas de PostgreSQL y del administrador inicial en `.env`. Docker no iniciará si están vacías. El usuario y contraseña iniciales solo se usan si todavía no hay usuarios:

```env
POSTGRES_PASSWORD=una-clave-unica-para-postgres
INITIAL_ADMIN_USER=admin
INITIAL_ADMIN_PASSWORD=otra-clave-unica
```

Compose construye la URL de PostgreSQL usando `POSTGRES_USER`, `POSTGRES_PASSWORD` y `POSTGRES_DB`. Elegí una contraseña de PostgreSQL sin caracteres reservados de URL (`@`, `:`, `/`, `#`, `%`) para evitar errores de conexión. Cambiar `INITIAL_ADMIN_PASSWORD` después de crear el usuario no cambia la contraseña guardada; usá Configuración dentro del sistema.

El puerto publicado es el `APP_PORT` (3000 por defecto). `APP_BIND_IP=0.0.0.0` permite el acceso desde otros equipos de la red local; para que solo abra en la notebook, cambiá ese valor a `127.0.0.1`.

Para acceso directo por IP local (sin proxy), mantené:

```env
TRUST_PROXY=0
HTTPS=0
```

El acceso directo usa HTTP. Usalo solamente en una red privada y confiable; para redes no confiables, configurá acceso mediante VPN o un proxy HTTPS.

## 2) Levantar los contenedores

Desde la carpeta del proyecto (donde está `docker-compose.yml`):

Solo si estás migrando una instalación existente, copiá los backups del contenedor anterior antes de recrearlo. En un equipo nuevo, omití este paso:

```powershell
New-Item -ItemType Directory -Force backups
docker compose cp app:/app/data/backups/. ./backups/
```

```powershell
# Construir e iniciar
docker compose up -d --build

# Ver logs mientras arranca
docker compose logs -f app
```

La primera vez tarda un poco porque construye la imagen. Docker no carga productos, ventas ni otros datos de demostración; la base inicia vacía y el sistema crea únicamente el usuario administrador inicial y los registros técnicos que necesita. Verás algo como:

```
Sistema Panadería corriendo en http://localhost:3000 (PostgreSQL)
...
Versión de prueba activada 60 días (hasta ...)
Código para reiniciar la prueba: ...
Código de activación permanente: ...
Guardados en /app/data/codigos-de-licencia.txt
```

En una base nueva puede aparecer:
```
Acceso creado: usuario "admin" / contraseña "..."
```

## 3) Acceder a la aplicación

Desde la misma notebook:

- http://localhost:3000 (o el puerto configurado en `APP_PORT`)

Desde otros equipos de la misma red privada:

- http://<IP-DE-LA-NOTEBOOK>:3000 (o el puerto configurado en `APP_PORT`)

Permití el puerto elegido en el Firewall de Windows solo para redes privadas. No configures reenvío del puerto 3000 desde el router hacia Internet. Cambiá la contraseña del administrador apenas ingreses.

## 4) Comandos útiles

```bash
# Ver estado
docker compose ps

# Ver logs
docker compose logs -f app
docker compose logs -f db

# Reiniciar
docker compose restart

# Parar (conserva los datos)
docker compose down

# Parar y BORRAR volúmenes (CUIDADO: borra la BD y archivos de la app; no la carpeta backups del host)
# docker compose down -v

# Actualizar el código y reconstruir la imagen
docker compose up -d --build
```

## 5) Datos persistentes

Todo queda guardado en volúmenes de Docker:

- `panaderia_pg_data` - Base de datos PostgreSQL
- `panaderia_app_data` - Archivos de licencia y otros archivos de la aplicación

Los backups diarios de PostgreSQL se guardan en la carpeta `backups` junto al proyecto, con retención de 7 días. La aplicación escribe allí a través de `BACKUP_PATH`. Copiá periódicamente esos archivos a un disco externo u otro equipo: el respaldo en la misma notebook no protege contra pérdida o daño del SSD.

No guardes la base PostgreSQL en una carpeta compartida de Windows: el volumen administrado por Docker evita la penalización de I/O de montajes desde NTFS. Los archivos de backup son pequeños y sí quedan en la carpeta Windows para copiarlos fácilmente.

Docker Desktop corre sobre WSL2. En un equipo con 8 GB de RAM, asignale alrededor de 3–4 GB y 2 CPU en Docker Desktop; Compose limita PostgreSQL a 768 MB y la app a 512 MB por defecto. Los límites son configurables en `.env`.

## 6) Notas importantes

- **Sin datos de prueba:** Docker mantiene desactivada la carga de datos de demostración. La opción de seed queda reservada para entornos de prueba; no la actives en producción.
- **Licencia:** en primera ejecución queda en **versión de prueba 60 días**. Los códigos se guardan en `/app/data/codigos-de-licencia.txt` (también visible en logs). Para activar versión completa necesitás el código correspondiente.
- **Red local:** la app se publica en la red privada según `APP_BIND_IP`. Limitá el acceso con el Firewall de Windows; no la expongas directamente a Internet.
- **pg_dump:** la imagen ya trae `postgresql-client-16` para los backups automáticos.
- **Healthcheck:** podés chequear `http://localhost:3000/healthz` (responde `{"ok":true}` si todo va bien).
- **Puerto ocupado:** cambiá `APP_PORT=3000` por otro puerto libre (por ejemplo, `3001`) en `.env` y recreá los contenedores.
- **Actualizar:** al traer cambios nuevos, reconstruí con `docker compose up -d --build` (la app usa la imagen nueva).
