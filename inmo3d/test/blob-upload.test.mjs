import assert from 'node:assert/strict';
import { test } from 'node:test';

test('Blob token authorization cannot overwrite property metadata', async () => {
    process.env.VERCEL = '1';
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test-only';
    process.env.INMO3D_ADMIN_TOKEN = 'test-admin-key-that-is-at-least-32-characters';
    const { default: handler } = await import('../api/index.js');
    const { login } = await import('../server/auth.mjs');
    let cookie;
    login({ headers: {} }, { setHeader: (key, value) => { cookie = value.split(';')[0]; } }, process.env.INMO3D_ADMIN_TOKEN);
    const invoke = async (body, headers = {}) => {
        let status, response;
        await handler({ url: '/api/blob/upload', method: 'POST', headers, body }, {
            writeHead: (code) => { status = code; },
            end: (text) => { response = JSON.parse(text); }
        });
        return { status, response };
    };
    const body = pathname => ({ type: 'blob.generate-client-token', payload: { pathname, multipart: false } });
    assert.equal((await invoke(body('example/photos/photo.jpg'))).status, 401);
    const overwrite = await invoke(body('example/property.json'), { cookie });
    assert.notEqual(overwrite.status, 200);
    assert.match(overwrite.response.error, /Ruta de subida inválida/);
    const callback = await invoke({ type: 'blob.upload-completed', payload: {} });
    assert.notEqual(callback.status, 200);
});
