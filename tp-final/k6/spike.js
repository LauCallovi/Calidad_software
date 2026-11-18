import http from 'k6/http';
import { check } from 'k6';
import { BASE, reportar } from './common.js';

// E2 (SPIKE): pico casi vertical de 20 a PEAK (default 1500) req/s en 5 s.
// MODE=cpu (default): mitad escrituras, mitad /api/debug/burn -> satura CPU y
//   muestra si el HPA llega a tiempo.
// MODE=oom: /api/debug/leak retiene memoria -> los pods superan el limit,
//   K8s los mata (OOMKilled) y los reinicia; medimos la recuperación.
const MODE = __ENV.MODE || 'cpu';
// PEAK / MAX_VUS: en una PC chica 1500 req/s satura al propio k6 antes que al
// cluster; se puede bajar (ej. -e PEAK=600 -e MAX_VUS=1000) y anotarlo en el informe.
const PEAK = Number(__ENV.PEAK || 1500);
const MAX_VUS = Number(__ENV.MAX_VUS || 3000);

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: Math.min(500, MAX_VUS),
      maxVUs: MAX_VUS,
      stages: [
        { target: 20, duration: '30s' },    // calma (referencia)
        { target: PEAK, duration: '5s' },   // pico casi vertical
        { target: PEAK, duration: '2m' },   // sostenido
        { target: 20, duration: '10s' },    // vuelta a la calma
        { target: 20, duration: '2m' },     // observar recuperación
      ],
    },
  },
};

export default function () {
  if (MODE === 'oom') {
    const r = http.get(`${BASE}/api/debug/leak?mb=5`, { timeout: '10s' });
    check(r, { 'leak 200': (x) => x.status === 200 });
  } else if (Math.random() < 0.5) {
    const r = http.get(`${BASE}/api/debug/burn?ms=50`, { timeout: '10s' });
    check(r, { 'burn 200': (x) => x.status === 200 });
  } else {
    reportar();
  }
}
