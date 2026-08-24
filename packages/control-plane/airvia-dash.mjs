import { openStore } from '@spicyspec/store';
import { startControlPlane } from '@spicyspec/control-plane';
const store = openStore('C:/XIII/share/Work/airvia/.spicyspec/runner.db');
const cp = await startControlPlane({ store, projectName: 'Airvia', port: 4478 });
console.log('up http://127.0.0.1:' + cp.port);
await new Promise(() => {});
