import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// El contrato de privacidad: cada tour se abre con su link, pero la cartera
// completa no se lista sin sesión.
test('la cartera es privada y cada propiedad sigue siendo pública', async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inmo3d-priv-'));
    process.env.INMO3D_DATA = dataDir;
    delete process.env.VERCEL;
    delete process.env.INMO3D_ADMIN_TOKEN;
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
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = (route, headers = {}) => fetch(`${base}${route}`, { headers });

    const created = await fetch(`${base}/api/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meta: { title: 'Casa reservada' } })
    });
    const { id } = await created.json();

    // Sin clave configurada (uso local) todo sigue abierto, como antes.
    assert.equal((await get('/api/properties')).status, 200);

    const token = 'clave-de-prueba-de-al-menos-32-caracteres';
    process.env.INMO3D_ADMIN_TOKEN = token;
    process.env.VERCEL = '1';

    assert.equal((await get('/api/properties')).status, 401, 'el listado exige sesión');
    const detalle = await get(`/api/properties/${id}`);
    assert.equal(detalle.status, 200, 'cada propiedad sigue abierta por su link');
    assert.equal((await detalle.json()).meta.title, 'Casa reservada');

    const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token })
    });
    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const conSesion = await get('/api/properties', { cookie });
    assert.equal(conSesion.status, 200, 'con sesión se lista');
    assert.equal((await conSesion.json()).length, 1);

    delete process.env.VERCEL;
    delete process.env.INMO3D_ADMIN_TOKEN;
});
