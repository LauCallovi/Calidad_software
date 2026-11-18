#!/usr/bin/env bash
# Verificación independiente de k6: ¿qué % de requests llega a cada versión?
#
# Uso:  ./scripts/conteo-curl.sh [N]      (N = cantidad de requests, default 100)
#
# Dos fuentes que deberían coincidir:
#  1) Lado cliente: N curls a /version.txt, contados por versión.
#  2) Lado servidor: líneas del log del Ingress controller que fueron al
#     upstream front-canary en el mismo período.
set -euo pipefail

TP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$TP_DIR"

N="${1:-100}"
URL="${FRONT_URL:-http://terrasense.local}/version.txt"
SALIDA="evidencias/reportes/conteo-$(date +%Y%m%d-%H%M%S).txt"
DESDE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PESO="$(kubectl -n terrasense get ingress terrasense-ingress-canary \
  -o jsonpath='{.metadata.annotations.nginx\.ingress\.kubernetes\.io/canary-weight}' 2>/dev/null || echo '?')"

{
  echo "Conteo $(date -Iseconds) | peso configurado: ${PESO}% | ${N} requests"
  echo "--- Lado cliente (curl sin cookies: cada request se sortea de nuevo) ---"
  for _ in $(seq 1 "$N"); do
    curl -s --max-time 5 "$URL" || echo "ERROR"
  done | sort | uniq -c

  # Pausa corta para que el controller termine de escribir los logs.
  sleep 2
  echo "--- Lado servidor (logs del Ingress controller desde ${DESDE}) ---"
  LOGS="$(kubectl -n ingress-nginx logs deploy/ingress-nginx-controller --since-time="$DESDE" 2>/dev/null || true)"
  # Cada línea del log trae los DOS nombres de upstream ([front-stable] y
  # [front-canary], principal y alternativo) sin importar adónde fue el
  # request, así que contar por nombre da lo mismo para ambos. Lo que sí
  # identifica el destino es la IP:puerto del pod que respondió.
  contar_track() {
    local ips patron
    ips=$(kubectl -n terrasense get pods -l "app=front,track=$1" -o jsonpath='{range .items[*]}{.status.podIP}{"\n"}{end}')
    [ -z "$ips" ] && { echo 0; return; }
    patron=$(sed 's/\./\\./g; s/$/:8080 /' <<<"$ips" | paste -sd'|')
    grep -cE " (${patron})" <<<"$LOGS" || true
  }
  echo "requests a front-canary: $(contar_track canary)"
  echo "requests a front-stable: $(contar_track stable)"
} | tee "$SALIDA"

echo "(guardado en $SALIDA)"
