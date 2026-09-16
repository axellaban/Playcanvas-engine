import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Una clave corta tiene que servir (hay que poder acordársela), pero entonces no
// puede probarse al infinito: después de cinco fallos el login se frena.
test('clave corta: entra bien y se frena tras varios fallos', async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inmo3d-auth-'));
    process.env.INMO3D_DATA = dataDir;
    delete process.env.VERCEL;
    // Con el token puesto, la sesión ya es obligatoria aunque no estemos en Vercel.
    process.env.INMO3D_ADMIN_TOKEN = 'casa25';
    const { default: handler } = await import('../api/index.js');
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => {
            server.close(resolve);
        });
        await fs.rm(dataDir, { recursive: true, force: true });
        delete process.env.INMO3D_ADMIN_TOKEN;
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = token => fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token })
    });

    const ok = await login('casa25');
    assert.equal(ok.status, 200, 'una clave de seis caracteres alcanza');
    const cookie = ok.headers.getSetCookie()[0].split(';')[0];

    const creada = await fetch(`${base}/api/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ meta: { title: 'Con clave corta' } })
    });
    assert.equal(creada.status, 201, 'la sesión sirve para escribir');

    for (let i = 0; i < 5; i++) assert.equal((await login('nope')).status, 401);
    assert.equal((await login('nope')).status, 429, 'al sexto intento, frenado');
    assert.equal((await login('casa25')).status, 429, 'el freno no se esquiva acertando');
});
