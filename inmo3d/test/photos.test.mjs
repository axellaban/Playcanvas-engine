import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Regresión: el panel sube las fotos de a tres en paralelo. Si cada subida
// reescribiera property.json, las tres se pisarían y se perderían fotos.
test('subir en paralelo no pierde fotos', async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inmo3d-fotos-'));
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

    const created = await fetch(`${base}/api/properties`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meta: { title: 'Carga paralela' } })
    });
    const { id } = await created.json();

    const total = 12;
    const subidas = await Promise.all(Array.from({ length: total }, async (_, i) => {
        const res = await fetch(`${base}/api/properties/${id}/photos?name=foto-${i}.jpg&register=0`, {
            method: 'POST',
            headers: { 'content-type': 'image/jpeg' },
            body: Buffer.from(`bytes-${i}`)
        });
        assert.equal(res.status, 201);
        return res.json();
    }));

    // Con register=0 los bytes se guardan pero la ficha todavía no los conoce.
    const antes = await (await fetch(`${base}/api/properties/${id}`)).json();
    assert.equal(antes.photos.length, 0);

    const attach = await fetch(`${base}/api/properties/${id}/attach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ photos: subidas })
    });
    assert.equal(attach.status, 201);

    const prop = await (await fetch(`${base}/api/properties/${id}`)).json();
    assert.equal(prop.photos.length, total, 'no se puede perder ninguna foto del lote');
    assert.equal(new Set(prop.photos.map(p => p.file)).size, total, 'ni duplicarse');
    for (const foto of prop.photos) assert.match(foto.url, /^\/media\//);

    // Reenviar el mismo lote no duplica: el registro es idempotente.
    await fetch(`${base}/api/properties/${id}/attach`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ photos: subidas })
    });
    const repetido = await (await fetch(`${base}/api/properties/${id}`)).json();
    assert.equal(repetido.photos.length, total);
});
