import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { BASE, reportar } from './common.js';

const MODE = __ENV.MODE || 'cpu';
const PEAK = Number(__ENV.PEAK || 1500);
const MAX_VUS = Number(__ENV.MAX_VUS || 3000);
const PRE_VUS = Math.min(500, MAX_VUS);

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: PRE_VUS,
      maxVUs: MAX_VUS,
      stages: [
        { target: 20, duration: '30s' },
        { target: PEAK, duration: '5s' },
        { target: PEAK, duration: '2m' },
        { target: 20, duration: '10s' },
        { target: 20, duration: '2m' },
      ],
    },
  },
};

export default function () {
  if (MODE === 'oom') {
    const r = http.get(`${BASE}/api/debug/leak?mb=5`, { timeout: '10s' });
    check(r, { 'leak 200': (x) => x.status === 200 });
  } else if (exec.scenario.iterationInTest % 2 === 0) {
    const r = http.get(`${BASE}/api/debug/burn?ms=50`, { timeout: '10s' });
    check(r, { 'burn 200': (x) => x.status === 200 });
  } else {
    reportar();
  }
}
