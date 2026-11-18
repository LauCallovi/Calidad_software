# Hallazgos de Horusec en el primer run de CI

**Run:** GitHub Actions #43995990963 (commit `e00a083`, 2026-11-17).
**Resultado:** el job `horusec` cortó en **rojo** y el job `build` quedó **skipped**. Así probamos que la compuerta del pipeline frena el armado de imágenes cuando aparecen problemas de seguridad.

Salieron **22 alertas** de severidad MEDIUM o HIGH (las LOW las filtramos con `-s LOW`).

## Resumen de decisiones

| # | Alerta | Motor / regla | Severidad | Archivos | Cant. | Qué hicimos |
|---|---|---|---|---|---|---|
| 1 | `Math.random()`: generador pseudoaleatorio débil | HorusecEngine `HS-JAVASCRIPT-6` | HIGH | `app/back/server.js` (`/api/debug/burn`) | 1 | **Corregido** |
| 2 | Misma regla sobre scripts de carga | `HS-JAVASCRIPT-6` | HIGH | `k6/common.js` (4), `k6/spike.js` (1) | 5 | **Falso positivo** (y reemplazado en `spike.js`) |
| 3 | El contenedor podría escalar privilegios | Trivy (K8s) | MEDIUM | back, front-stable, front-canary, db | 4 | **Corregido** |
| 4 | Contenedor ejecutando como root | Trivy | MEDIUM | back, front-stable, front-canary | 3 | **Corregido** |
| 5 | UID menor o igual a 10000 | Trivy | MEDIUM | back, front-stable, front-canary | 3 | **Corregido** |
| 6 | GID menor o igual a 10000 | Trivy | MEDIUM | back, front-stable, front-canary | 3 | **Corregido** |
| 7 | Root / UID bajo / GID bajo en la base | Trivy | MEDIUM | `k8s/base/02-db.yaml` (PostgreSQL) | 3 | **Riesgo aceptado** |

En números: **14 corregidos**, **5 falsos positivos** y **3 riesgos aceptados** (22 en total).

## Detalle por grupo

### 1. Azar innecesario en `server.js` (corregido)
Aparecía adentro de `/api/debug/burn`, la ruta de prueba que quema CPU para forzar el HPA. Para gastar ciclos de procesador no hace falta ningún número al azar, así que pusimos una cuenta determinista (`x = Math.sqrt(x + 1)`). Fue más directo sacar la llamada que cargar una excepción.

### 2. Uso de `Math.random()` en scripts de k6 (falso positivo + ajuste en `spike.js`)
La regla `HS-JAVASCRIPT-6` apunta a casos donde alguien arma tokens, claves o sesiones con un PRNG predecible (CWE-338). Acá `k6/common.js` solamente inventa valores de temperatura y humedad para poblar lecturas de sensores simulados, y esos archivos ni siquiera entran a las imágenes Docker de producción. Por eso quedaron declarados por hash en `tp-final/horusec-config.json` bajo `horusecCliFalsePositiveHashes`.

Durante las corridas de ejecución pasó algo interesante en el PR #6 (runs #44247654114 y #44247683182): al parametrizar `PEAK` y `MAX_VUS` arriba de `k6/spike.js`, se corrieron los números de línea y el hash viejo dejó de coincidir, volviendo a poner Horusec en rojo. Para no depender del número de línea en `spike.js`, cambiamos ese sorteo 50/50 por `exec.scenario.iterationInTest % 2 === 0`.

### 3 a 6. Permisos de contenedores en back y front (corregido)
Aunque los Dockerfiles ya bajaban a usuarios comunes (`node` con UID 1000 y nginx con UID 101), los manifiestos YAML no obligaban a Kubernetes a chequearlo. Trivy revisa el YAML estático, porque mañana alguien podría cambiar el tag de la imagen por otra que arranque como root. Agregamos en cada Deployment:

```yaml
securityContext:
  runAsNonRoot: true            # K8s rechaza levantar el pod si intenta ser root
  runAsUser: 10001              # back (en front usamos 10101), lejos de UIDs del host
  runAsGroup: 10001
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
```

En el frontend apareció un detalle práctico: nginx escribe su pid y archivos temporales en `/var/cache/nginx` y `/tmp`. Al correr con UID 10101 no tenía permisos sobre las carpetas de la imagen base, así que montamos dos volúmenes `emptyDir` en esas rutas. Además, el job `build` del workflow levanta cada imagen con `docker run --user` usando esos mismos UIDs para comprobar que no crashean al iniciar.

### 7. PostgreSQL iniciando como root (riesgo aceptado)
- **Qué cerramos:** pusimos `allowPrivilegeEscalation: false` en `02-db.yaml`.
- **Qué aceptamos:** el arranque inicial como root y el UID/GID bajos de la imagen `postgres:15-alpine`.
- **Motivo técnico:** el entrypoint oficial de Postgres ajusta permisos del directorio de datos como root y enseguida hace `su-exec` al usuario `postgres`. Forzar `runAsUser` desde afuera rompe la inicialización del PVC `hostPath` de Minikube salvo que agreguemos un `initContainer` privilegiado, que termina teniendo el mismo problema.
- **Mitigaciones activas:** el Service `db` es `ClusterIP` interno sin Ingress expuesto; la clave no vive en Git sino que la crea `deploy.sh` con `/dev/urandom` al levantar el cluster; las queries las atiende el proceso `postgres` sin privilegios.
- **Cómo resolverlo en un cluster productivo:** pasar a un operador como CloudNativePG (que maneja los volúmenes directo con UID 26 sin tocar root) o a una base administrada.
- Los tres hashes quedaron asentados en `horusecCliRiskAcceptHashes`.

## Segundo run (#44003617085, commit `6e0af9f`)

Tras subir los parches bajamos de 22 alertas a 1 sola, pero en un lugar insólito: `HS-JAVASCRIPT-6` saltó sobre un **comentario** en `server.js` donde habíamos escrito el nombre de la función vieja explicando por qué la sacábamos. Como el motor busca con expresiones regulares sobre el archivo plano, no distingue código ejecutable de comentarios. Reemplazamos esa línea del comentario y en el run #44008882096 todo el pipeline pasó en verde.

## Deuda detectada: falta escaneo de librerías (SCA)

En la consola de Horusec salió el aviso `Error while running tool NpmAudit: file package-lock.json was not found`. Al no haber commiteado `package-lock.json` en `app/back/`, NpmAudit no pudo cruzar las versiones instaladas de `express`, `pg` y `cors` contra bases de CVEs. Hoy revisamos nuestro código y los YAML, pero no los paquetes de npm. Queda anotado como mejora: generar el lockfile, pasar el Dockerfile a `npm ci` y sumar `npm audit` o `trivy fs` en el job de seguridad.

## Criterio entre falso positivo y riesgo aceptado
- **Falso positivo:** la alerta no aplica porque en ese archivo no existe riesgo real (por ejemplo, datos sintéticos de carga en `k6`).
- **Riesgo aceptado:** la debilidad técnica sí está, pero decidimos dejarla acotada con controles compensatorios y fecha/plan de reemplazo documentado.

En ambos casos los hashes quedan versionados en `horusec-config.json` en vez de apagar reglas enteras: si alguien toca el archivo, el hash cambia y el pipeline obliga a mirarlo otra vez.
