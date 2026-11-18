import { reportar, thresholds } from './common.js';

// LOAD (carga nominal): 2000 sensores x 1 reporte cada 30 s ~= 67 req/s.
// constant-arrival-rate: k6 mantiene 67 req/s aunque el sistema se ponga lento
// (modelo "abierto", como sensores reales que no esperan a nadie). Con un
// número fijo de usuarios, si el back se pone lento bajaría la carga y el
// problema quedaría oculto.
// RATE / DURATION: para la prueba de capacidad (10.000 sensores ≈ 333 req/s):
//   k6 run -e RATE=333 k6/load.js
const RATE = Number(__ENV.RATE || 67);
const DURATION = __ENV.DURATION || '5m';
// RAMP (opcional, ej. 2m): sube de 0 a RATE en ese tiempo y recién después
// sostiene RATE durante DURATION. Sin rampa, la carga entra de golpe (arranque
// en frío: todos los sensores a la vez); con rampa, el HPA alcanza a escalar
// y se mide el régimen estable.
const RAMP = __ENV.RAMP || '';

const flota = RAMP
  ? {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: '1s',
      stages: [{ target: RATE, duration: RAMP }, { target: RATE, duration: DURATION }],
      preAllocatedVUs: Math.max(50, RATE),
      maxVUs: Math.max(300, RATE * 5),
    }
  : {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(50, RATE),
      maxVUs: Math.max(300, RATE * 5),
    };

export const options = {
  scenarios: { flota },
  thresholds,
};

export default function () {
  reportar();
}
