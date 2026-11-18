import { createDemo } from './app.js';

const demo = createDemo({
    url: process.env.MQTT_URL ?? 'mqtt://broker.hivemq.com:1883',
    prefix: process.env.MQTT_PREFIX,
    username:process.env.MQTT_USERNAME, password:process.env.MQTT_PASSWORD,
    aclConfirmed:process.env.MQTT_ACL_CONFIRMED==='true',
    logDirectory: process.env.DATA_DIR ?? 'data'
});
const port = Number(process.env.PORT ?? 3000);
demo.server.listen(port, '127.0.0.1', () =>
{
    console.log(`Backend: http://localhost:${port} · versioned measured / synthetic ingestion`);
});
for (const signal of ['SIGINT', 'SIGTERM'])
{
    process.on(signal, async () =>
    {
        await demo.close();
        process.exit(0);
    });
}
