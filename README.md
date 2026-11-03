# Sistema de gestión para panadería

Aplicación local para gestionar ventas, productos, caja y sucursales. Usa Node.js, Express y PostgreSQL; la interfaz se sirve sin proceso de build.

## Requisitos

- Docker Desktop instalado y en ejecución, con Docker Compose.
- Windows 11 o un sistema compatible con Docker.

## Instalación en otro equipo

Cloná el repositorio y entrá a la carpeta:

```powershell
git clone https://github.com/Angel-Codes-842/panaderia.git
Set-Location panaderia
```

Prepará la configuración local:

```powershell
Copy-Item .env.example .env
notepad .env
```

Completá `POSTGRES_PASSWORD` e `INITIAL_ADMIN_PASSWORD` con contraseñas únicas. No compartas ni subas el archivo `.env`. La aplicación y la base de datos no aceptan iniciar con esos valores vacíos.

Construí e iniciá los servicios:

```powershell
docker compose up -d --build
docker compose ps
docker compose logs app
```

Abrí `http://localhost:3000`. Para instrucciones de acceso por red local, backups, actualización y configuración de recursos, consultá [README_DESPLIEGUE.md](./README_DESPLIEGUE.md).

La instalación nueva no carga productos, ventas ni otros datos de demostración. La base de datos y los archivos de la aplicación quedan en volúmenes de Docker; los backups se guardan en la carpeta local `backups/`.
