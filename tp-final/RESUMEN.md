# Apunte de estudio del TP Final (por fases)

Resumen directo para repasar todo lo que armamos en `tp-final/` antes de pasar al frente en el Aula 102.

## 0. Qué convive adentro del repositorio

En la raíz del repo quedó el código viejo de **SatisPlanning** que habíamos usado en TP1 y TP2 para practicar linters en Python y Horusec. Todo el trabajo nuevo de TerraSense vive aislado adentro de `tp-final/`, más el workflow `.github/workflows/tp-final-ci.yml` que se dispara únicamente cuando un push o PR toca archivos de `tp-final/**`.

## Fase 1: Backend, Kubernetes base y pruebas de TP3

- **API (`app/back/server.js`):** servidor Express conectado a PostgreSQL (`pg`). Expone `POST /api/sensores` y `GET /api/stats` para la flota ESP32, `/healthz` para `livenessProbe` (mira que el proceso Node siga vivo), `/readyz` para `readinessProbe` (hace un `SELECT 1` contra Postgres y saca el pod del Service si la base no contesta) y dos rutas de laboratorio (`/api/debug/burn` y `/api/debug/leak`) para gatillar CPU y memoria en E2. No tiene contraseña por defecto en el código: si falta `DB_PASSWORD`, el proceso corta en el arranque.
- **Base de datos (`k8s/base/02-db.yaml`):** corre en un `StatefulSet` (`db-0`) con `PersistentVolumeClaim` de 1 GiB y `PGDATA` apuntando a una subcarpeta para no chocar con `lost+found`. La clave se genera una sola vez con `/dev/urandom` en `deploy.sh` y se guarda en el Secret `db-secret`.
- **Autoescalado (`03-back.yaml` y `04-hpa.yaml`):** cada pod `back` pide `requests.cpu: 100m` (`limits: 500m`, RAM `128Mi` a `256Mi`). El HPA calcula el porcentaje sobre los `100m` del request y mueve las réplicas entre 2 y 8 cuando el promedio supera 60%.
- **Batería base en `k6/`:** `smoke.js` (1 VU x 30s para ver que responde), `load.js` (67 req/s constantes para 2.000 sensores, y parametrizable con `RATE=333 RAMP=1m` para probar los 10.000 sensores), `stress.js` (escalera de 100 a 1200 req/s hasta superar 10% de error), `e1-carga-estable.js` + `browser-ux.js` (borrado manual de un pod bajo 40 req/s) y `spike.js` (golpe vertical de CPU o fuga de RAM hasta `OOMKilled`).

## Fase 2: Las tres variantes del frontend (`app/front/`)

Usamos un único `Dockerfile` basado en `nginxinc/nginx-unprivileged:1.27-alpine` (corre en el puerto 8080 con UID no-root). Al compilar con `--build-arg APP_VERSION=X.Y.Z` copia la carpeta `vX.Y.Z/` e inyecta automáticamente tres marcas:
1. `<meta name="app-version" content="X.Y.Z">` en `index.html` (leída desde el DOM por `k6/browser`).
2. Archivo estático `/version.txt` (usado por la `readinessProbe` de cada pod y por `conteo-curl.sh`).
3. Header `X-App-Version` agregado con `always` en `nginx.conf` para que salga tanto en `200` como en `404`.

Diferencias entre las tres imágenes:
- **`1.0.0` (stable):** diseño sobrio oscuro con CSS y JS embebidos adentro del mismo HTML (1 solo request por visita).
- **`1.1.0` (canary candidata):** fondo verde brillante y cartel fijo arriba para distinguirla de lejos en cualquier captura, con `/assets/app-1.1.0.css` y `/assets/app-1.1.0.js` servidos aparte (3 requests por visita). En `nginx.conf` bloqueamos el fallback a `index.html` dentro de `/assets/` para que si falta un archivo devuelva `404` real en vez de entregar HTML disfrazado de JS.
- **`1.2.0` (rota a propósito):** reproduce el incidente de la helada. El HTML y `app-1.2.0.js` devuelven `200 OK`, pero el script intenta leer `window.__TERRASENSE_CONFIG__.api.baseUrl` sobre `undefined`, lanza `TypeError` y deja `<div id="app">` completamente vacío.

## Fase 3: Topología Canary con NGINX Ingress (`k8s/`)

- **Dos Deployments y dos Services:** `front-stable` (`track: stable`, 2 réplicas) y `front-canary` (`track: canary`, 1 réplica en rollout y 2 réplicas durante el estrés A/B), ambos con los mismos `requests` y `limits` (`50m/64Mi` a `250m/128Mi`). Si usáramos un solo Service con `app: front`, Kubernetes mezclaría pods por cantidad de réplicas sin dejarnos regular porcentajes finos. El `selector` lleva solo `app` y `track` (sin `version`) porque en Kubernetes `spec.selector` es inmutable.
- **Orden de ruteo en `terrasense-ingress-canary`:** primero manda `canary-by-header: "X-Canary"` (`always` fuerza canary, `never` fuerza stable), segundo `canary-by-cookie: "canary"` (`canary=always` para pruebas de QA con peso 0) y tercero `canary-weight` (0 a 100).
- **Afinidad de sesión y separación de la API:** prendimos `affinity: cookie` (`terrasense-front`, TTL 3600s) tanto en `terrasense-ingress` como en `terrasense-ingress-canary` para que el navegador pida el HTML y sus `/assets/` al mismo track. Como la anotación de afinidad afecta a todas las reglas de un mismo Ingress, mudamos `api.terrasense.local` a un tercer recurso `terrasense-ingress-api` sin cookies; de lo contrario cada sensor o VU de `k6` quedaría clavado a un único pod del `back` y deformaría el HPA.

## Fase 4 y 5: Scripts de medición y automatización (`k6/` y `scripts/`)

- **`front-common.js`:** limpia el cookie jar al arrancar cada iteración (simulando un visitante nuevo para que el porcentaje medido respete `canary-weight`), baja `/` y enseguida pide en lote (`http.batch`) los `/assets/` manteniendo la cookie dentro de esa misma visita. Marca `assetsRotos` si alguno no da `200` o trae otro `X-App-Version`.
- **`front-canary-split.js` y `browser-canary.js`:** corren juntos en cada etapa de `rollout.sh`. El primero mete carga abierta HTTP y chequea errores y `p95` de HTML; el segundo abre Chromium limpio `N` veces y verifica que `document.body.innerText` no esté vacío.
- **`rollout.sh`, `peso.sh` y `conteo-curl.sh`:** `peso.sh` anota el Ingress en caliente, actualiza `ingress-canary.yaml` para que Git no quede desfasado del cluster y deja hora en `cambios-de-peso.log`. `conteo-curl.sh` tira 100 curls sin cookies y cuenta del lado servidor buscando la `IP:8080` de los pods en los logs de `ingress-nginx`. Cuando una etapa falla, `rollback()` baja peso a `0` y también escala `front-canary` a `0` réplicas para despegar en el acto a quienes ya tenían cookie sticky. Al promover, actualiza primero `front-stable` a `1.1.0`, espera `rollout status`, baja peso a `0` y recién ahí apaga el canary.
- **`front-stress.js`:** corre el experimento A/B con `front-canary` escalado a 2 réplicas y peso 0, apuntando primero con `X-Canary: never` y después con `X-Canary: always` en escalones de 50, 100, 200, 400 y 800 cargas/s.

## Fase 6 y 7: Compuerta CI e ISO/IEC 25000

- **GitHub Actions (`tp-final-ci.yml`):** el job `lint` corre `htmlhint`, `ESLint` y `hadolint`; el job `horusec` compila Horusec y ejecuta SAST + Trivy. Solo si ambos salen en verde arranca `build`, que construye las 4 imágenes y verifica con `docker run --user` que levanten con UIDs `> 10000`. En la historia real del repo quedaron grabados el run rojo `#43995990963` (22 alertas), el `#44003617085` (1 alerta sobre un comentario) y el verde `#44008882096`.
- **Lectura SQuaRE (ISO/IEC 25000):** fijamos umbrales en `25030` (`thresholds`), recolectamos métricas en `25022`/`25023`, automatizamos el juicio de paso/rollback en `25040` (y recuperabilidad ante fallas en `25045`), y mostramos con la `v1.2.0` la brecha entre medir el servidor (`25010`, todo `200 OK`) y medir lo que realmente percibe el productor en pantalla (`25019`, calidad en uso).
