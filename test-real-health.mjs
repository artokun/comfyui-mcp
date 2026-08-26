import { runHealthCheck } from './dist/services/health-check.js';

const result = await runHealthCheck({ recentErrors: 5 });
console.log(result);
