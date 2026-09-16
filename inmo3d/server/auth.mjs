import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'inmo3d_admin';
const TTL = 12 * 60 * 60;
const secret = () => process.env.INMO3D_ADMIN_TOKEN || '';
const configured = () => secret().length >= 32;
const required = () => process.env.VERCEL === '1' || !!secret();
const signature = value => createHmac('sha256', secret()).update(`inmo3d:${value}`).digest('hex');
const equal = (a, b) => {
    const x = Buffer.from(a), y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
};

/** Estado de sesión. No devuelve la clave ni el contenido de la cookie. */
export function authStatus(req) {
    if (!required()) return { required: false, configured: false, authenticated: true };
    const cookie = String(req.headers.cookie || '').split(';').map(v => v.trim())
    .find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
    const [expires, mac] = cookie.split('.');
    const now = Math.floor(Date.now() / 1000);
    const authenticated = configured() && /^\d+$/.test(expires || '') &&
        Number(expires) > now && Number(expires) <= now + TTL &&
        equal(mac || '', signature(expires));
    return { required: true, configured: configured(), authenticated };
}

/** Impide escrituras desde formularios de otros sitios, incluso en el servidor local. */
export function sameOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (!req.headers.origin) return true;
    try {
        return new URL(req.headers.origin).host === req.headers.host;
    } catch {
        return false;
    }
}

/** Exige sesión antes de modificar datos, emitir tokens de Blob o consumir IA. */
export function requireAdmin(req) {
    if (!sameOrigin(req)) throw Object.assign(new Error('Origen no permitido.'), { status: 403 });
    const auth = authStatus(req);
    if (auth.authenticated) return;
    const error = auth.configured ? 'Iniciá sesión para editar o usar IA.' :
        'La edición está deshabilitada: configurá INMO3D_ADMIN_TOKEN (mínimo 32 caracteres) en el servidor.';
    throw Object.assign(new Error(error), { status: auth.configured ? 401 : 503 });
}

const sessionCookie = (value, age) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${
    process.env.VERCEL === '1' ? '; Secure' : ''}`;

/** Verifica la clave administrativa y emite una sesión firmada de 12 horas. */
export function login(req, res, token) {
    if (!sameOrigin(req)) throw Object.assign(new Error('Origen no permitido.'), { status: 403 });
    if (!configured()) throw Object.assign(new Error('El acceso administrativo aún no está configurado.'), { status: 503 });
    if (typeof token !== 'string' || token.length > 512 || !equal(token, secret())) {
        throw Object.assign(new Error('Clave incorrecta.'), { status: 401 });
    }
    const expires = String(Math.floor(Date.now() / 1000) + TTL);
    res.setHeader('set-cookie', sessionCookie(`${expires}.${signature(expires)}`, TTL));
}

/** Elimina la sesión del navegador. Rotar INMO3D_ADMIN_TOKEN invalida todas las sesiones. */
export function logout(req, res) {
    if (!sameOrigin(req)) throw Object.assign(new Error('Origen no permitido.'), { status: 403 });
    res.setHeader('set-cookie', sessionCookie('', 0));
}
