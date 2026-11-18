# Apunte de tiempos para la defensa oral (15 a 18 min)

En el Aula 102 no hay demo en vivo, todo sale de las capturas y videos que grabamos en el repo. Nos repartimos en 5 tramos de unos 3 minutos por integrante, actuando como el equipo de plataforma y QA de TerraSense S.A. frente al directorio y la gente de la Cooperativa.

## Tramo 1 (min 0 a 3.5): Incidente de la helada y línea base en Minikube
Arrancamos contando qué nos trajo hasta acá: en un deploy anterior se cambiaron todos los pods del panel al mismo tiempo y los productores quedaron 40 minutos viendo una página vacía en plena helada, mientras el chequeo HTTP daba todo 200. Además la Cooperativa quiere pasar de 2.000 a 10.000 sensores ESP32 mandando lecturas cada 30 segundos.

Mostramos `01-deploy-kubectl.png` y `02-load.png`: PostgreSQL en StatefulSet con PVC, `back` en Node/Express con probes `/readyz` y `/healthz`, y el HPA regulando de 2 a 8 réplicas al superar 60% de CPU sobre el `request`. A carga actual (67 req/s) responde holgado debajo de los 300 ms de p95; en el video `02-stress-hpa.mp4` se ve hasta dónde escala antes de saturar.

## Tramo 2 (min 3.5 a 7): Compuerta de CI y pruebas de rotura (E1 / E2)
Pasamos al workflow `.github/workflows/tp-final-ci.yml` con las capturas `07-ci-rojo.png` y `07-ci-verde.png`. Si fallan los linters (`htmlhint`, `ESLint`, `hadolint`) o salta Horusec + Trivy, el job `build` ni siquiera arranca. En la primera corrida saltaron 22 alertas: sacamos `Math.random()` del endpoint `/api/debug/burn`, endurecimos `securityContext` con UID mayores a 10000 y `emptyDir` para nginx, dejamos documentados los falsos positivos de `k6` y aceptamos con controles el inicio de Postgres. Hasta nos pasó en el segundo run que Horusec marcó un comentario de texto plano.

Cerramos este tramo con `03-e1-pod-eliminado.mp4` y `04-oomkilled.png`: matando un pod del `back` bajo 40 req/s apenas caen un puñado de paquetes en menos de 1 segundo y la UI ni parpadea; forzando memoria con `/api/debug/leak` Kubernetes mata por `OOMKilled` (código 137) y levanta de nuevo el contenedor solo.

## Tramo 3 (min 7 a 11.5): Despliegue Canary de la v1.1.0
Acá mostramos las tres imágenes salidas del mismo Dockerfile (`1.0.0`, `1.1.0` verde flúo con CSS/JS externos, y `1.2.0` rota). Todas llevan tres marcas: header `X-App-Version`, etiqueta `<meta name="app-version">` y `/version.txt`.

Explicamos los manifiestos de `k8s/`: dos Deployments (`front-stable` y `front-canary`), dos Services filtrando por `track`, y dos Ingress sobre `terrasense.local`. El pod de `ingress-nginx` evalúa en orden `X-Canary` -> cookie `canary` -> `canary-weight`. Pusimos afinidad por cookie `terrasense-front` en el front para que un navegador no cruce HTML de `1.1.0` con assets de `1.0.0`, y separamos `api.terrasense.local` en un tercer Ingress sin afinidad para no clavar la carga en un único pod del `back`.

Con `03-etapa0-cookie.png`, la grilla de 20 visitas y el video `05-rollout-1.1.0.mp4` mostramos `rollout.sh` pasando por Etapa 0 (peso 0 con cookie) y después 10%, 25%, 50% y 100%, validado también desde afuera con `conteo-curl.sh` leyendo las IPs de pods en los logs del Ingress.

## Tramo 4 (min 11.5 a 15): Rollback automático de la v1.2.0 y estrés A/B
Ponemos el video `06-rollback-1.2.0.mp4` junto con `06-network-200.png` y `06-consola-typeerror.png`. La `v1.2.0` devuelve `200 OK` en red pero tira `TypeError` al buscar `window.__TERRASENSE_CONFIG__.api` y deja `<div id="app">` vacío. En Demo A la Etapa 0 la corta con peso 0 sin afectar a ningún productor. En Demo B abrimos al 25%: k6 HTTP da verde, pero Chromium detecta `innerText` vacío y ejecuta rollback llevando peso a 0 y `front-canary` a 0 réplicas para soltar también las sesiones sticky.

Después mostramos `04-estres-stable.png`, `04-estres-canary.png` y `02-capacidad-333.png`: escalamos `front-canary` a 2 réplicas igual que `front-stable`, dejamos peso 0 y tiramos rampas de 50 a 800 cargas/s por versión con header `X-Canary`. Comparamos qué dio en la notebook de 2 CPUs / 3 GB frente a la máquina de 4 CPUs / 6 GB, y cómo rindió el backend a 333 req/s (equivalente a 10.000 sensores).

## Tramo 5 (min 15 a 18): Norma ISO/IEC 25000 y dictamen final
Recorremos la tabla SQuaRE: nuestros `thresholds` son requisitos `25030`, los JSON/CSV de k6 son mediciones `25022`/`25023`, `rollout.sh` implementa la evaluación `25040` (y `25045` en recuperabilidad ante fallas), y el salto de k6 HTTP a `k6/browser` marca el paso de mirar solo el producto (`25010`) a mirar calidad en uso (`25019`). Nombramos lo que falta cubrir: accesibilidad con Lighthouse/axe, pruebas de contrato front-back con Pact, DAST con OWASP ZAP, `package-lock.json` para NpmAudit y migración futura de `ingress-nginx` (archivado en marzo de 2026) a Gateway API (`HTTPRoute`). Cerramos con el dictamen Go / No-Go y el orden exacto de promoción (`front-stable` a `1.1.0` -> `rollout status` -> peso 0 -> canary en 0 réplicas).

## Ayuda memoria para preguntas de los profes
- **Por qué no usar un RollingUpdate común:** porque en un Deployment estándar el reparto depende del número de pods (con 2 pods pasás directo al 50%) y no podés entrar por cookie con 0% de tráfico público.
- **Quién reparte los porcentajes:** NGINX Ingress Controller dentro del pod de `ingress-nginx`, no `kube-proxy`.
- **Por qué bajar réplicas a 0 en el rollback:** la cookie sticky dura 1 hora; si solo bajás `canary-weight` a 0, el usuario que ya cayó en la `1.2.0` sigue viendo pantalla blanca al recargar hasta que matás las réplicas del canary.
- **Por qué peso 100% no alcanza como promoción:** si dejás `front-stable` en `1.0.0` y mañana borrás el recurso canary, deshacés el release sin querer.
