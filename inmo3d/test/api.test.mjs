import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('HTTP routing, property lifecycle and administrative sessions', async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inmo3d-test-'));
    process.env.INMO3D_DATA = dataDir;
    delete process.env.VERCEL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_STORE_ID;
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
    const request = async (route, method = 'GET', body, headers = {}) => {
        const response = await fetch(`${base}${route}`, {
            method,
            headers: { 'content-type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        assert.match(response.headers.get('content-type'), /application\/json/);
        return { status: response.status, data: await response.json(), headers: response.headers };
    };
    let cookie;
    const token = 'test-only-random-admin-key-with-32-characters';

    await t.test('creates local fixture, resolves direct and rewritten nested routes', async () => {
        const created = await request('/api/properties', 'POST', { meta: { title: 'Casa de prueba' } });
        assert.equal(created.status, 201);
        assert.equal(created.data.id, 'casa-de-prueba');
        for (const route of ['/api/properties/casa-de-prueba', '/api/index?__path=properties/casa-de-prueba']) {
            const detail = await request(route);
            assert.equal(detail.status, 200);
            assert.equal(detail.data.meta.title, 'Casa de prueba');
        }
        assert.equal((await request('/api/index?__path=properties/casa-de-prueba/job')).status, 200);
        assert.equal((await request('/api/properties/no-existe')).status, 404);
        assert.equal((await request('/api/properties/%2e%2e%2ftest')).status, 400);
    });

    await t.test('Vercel fails closed without an admin key, including short keys', async () => {
        process.env.VERCEL = '1';
        for (const value of ['', 'short']) {
            process.env.INMO3D_ADMIN_TOKEN = value;
            assert.equal((await request('/api/config')).data.auth.authenticated, false);
            assert.equal((await request('/api/properties', 'POST', {})).status, 503);
            assert.equal((await request('/api/properties/casa-de-prueba', 'DELETE')).status, 503);
        }
        process.env.INMO3D_ADMIN_TOKEN = token;
    });

    await t.test('rejects anonymous updates, deletes, AI and cross-site login', async () => {
        for (const [route, method] of [
            ['/api/properties', 'POST'],
            ['/api/properties/casa-de-prueba', 'PATCH'],
            ['/api/properties/casa-de-prueba', 'DELETE'],
            ['/api/properties/casa-de-prueba/attach', 'POST'],
            ['/api/properties/casa-de-prueba/ai/listing', 'POST']
        ]) assert.equal((await request(route, method, {})).status, 401);
        assert.equal((await request('/api/auth/login', 'POST', { token: 'wrong' })).status, 401);
        assert.equal((await request('/api/auth/login', 'POST', { token }, { origin: 'https://other.test' })).status, 403);
        const response = await request('/api/auth/login', 'POST', { token });
        assert.equal(response.status, 200);
        const setCookie = response.headers.get('set-cookie');
        assert.match(setCookie, /HttpOnly; SameSite=Strict; Max-Age=43200; Secure/);
        cookie = setCookie.split(';')[0];
    });

    await t.test('authenticated edits survive reads; cross-site writes and forged sessions fail', async () => {
        assert.equal((await request('/api/config', 'GET', undefined, { cookie })).data.auth.authenticated, true);
        const patch = await request('/api/index?__path=properties/casa-de-prueba', 'PATCH', { meta: { city: 'Buenos Aires' } }, { cookie });
        assert.equal(patch.status, 200);
        assert.equal((await request('/api/properties/casa-de-prueba')).data.meta.city, 'Buenos Aires');
        assert.equal((await request('/api/properties/casa-de-prueba', 'DELETE', undefined, { cookie, origin: 'https://other.test' })).status, 403);
        assert.equal((await request('/api/properties', 'POST', {}, { cookie: `${cookie}x` })).status, 401);
        const out = await request('/api/auth/logout', 'POST', {}, { cookie });
        assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
        process.env.INMO3D_ADMIN_TOKEN = `${token}-rotated`;
        assert.equal((await request('/api/properties', 'POST', {}, { cookie })).status, 401);
    });

    await t.test('frontend reports non-JSON infrastructure errors clearly', async () => {
        const originalFetch = globalThis.fetch;
        const { api } = await import('../public/src/ui.mjs');
        try {
            globalThis.fetch = () => Promise.resolve(new Response('The page could not be found', { status: 404 }));
            await assert.rejects(() => api('/properties/example'), /HTTP 404 sin JSON/);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
