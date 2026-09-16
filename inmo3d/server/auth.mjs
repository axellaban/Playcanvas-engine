import { createHmac, scryptSync, timingSafeEqual } from 'node:crypto';

const COOKIE = 'inmo3d_admin';
const TTL = 12 * 60 * 60;
const MIN = 6;
const INTENTOS = 5;
const ESPERA = 15 * 60 * 1000;

const secret = () => process.env.INMO3D_ADMIN_TOKEN || '';
const configured = () => secret().length >= MIN;
const required = () => process.env.VERCEL === '1' || !!secret();

// La clave que firma la sesión no es el token pelado: se deriva con scrypt. Con un
// token corto eso es lo que hace que adivinarlo a partir de una cookie robada cueste
// caro en vez de barato. El resultado se cachea porque se usa en cada request.
let derivada = { token: null, key: null };
function claveDeFirma() {
    const token = secret();
    if (derivada.token !== token) derivada = { token, key: scryptSync(token, 'inmo3d/session/v1', 32) };
    return derivada.key;
}
const signature = value => createHmac('sha256', claveDeFirma()).update(`inmo3d:${value}`).digest('hex');

// Un token corto sólo es defendible si no se puede probar al infinito.
const intentos = new Map();
const quien = req => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress || 'local');

function frenar(req) {
    const ip = quien(req);
    const registro = intentos.get(ip);
    if (registro && registro.hasta > Date.now() && registro.fallos >= INTENTOS) {
        const minutos = Math.ceil((registro.hasta - Date.now()) / 60000);
        throw Object.assign(new Error(`Demasiados intentos. Probá de nuevo en ${minutos} minuto(s).`), { status: 429 });
    }
    return ip;
}

function anotarFallo(ip) {
    const ahora = Date.now();
    const registro = intentos.get(ip);
    const vigente = registro && registro.hasta > ahora ? registro : { fallos: 0, hasta: ahora + ESPERA };
    vigente.fallos++;
    intentos.set(ip, vigente);
    // La tabla no puede crecer sin límite en un proceso largo.
    if (intentos.size > 5000) {
        for (const [k, v] of intentos) if (v.hasta <= ahora) intentos.delete(k);
    }
}
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
        `La edición está deshabilitada: configurá INMO3D_ADMIN_TOKEN (mínimo ${MIN} caracteres) en el servidor.`;
    throw Object.assign(new Error(error), { status: auth.configured ? 401 : 503 });
}

const sessionCookie = (value, age) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${
    process.env.VERCEL === '1' ? '; Secure' : ''}`;

/** Verifica la clave administrativa y emite una sesión firmada de 12 horas. */
export function login(req, res, token) {
    if (!sameOrigin(req)) throw Object.assign(new Error('Origen no permitido.'), { status: 403 });
    if (!configured()) throw Object.assign(new Error('El acceso administrativo aún no está configurado.'), { status: 503 });
    const ip = frenar(req);
    if (typeof token !== 'string' || token.length > 512 || !equal(token, secret())) {
        anotarFallo(ip);
        throw Object.assign(new Error('Clave incorrecta.'), { status: 401 });
    }
    intentos.delete(ip);
    const expires = String(Math.floor(Date.now() / 1000) + TTL);
    res.setHeader('set-cookie', sessionCookie(`${expires}.${signature(expires)}`, TTL));
}

/** Elimina la sesión del navegador. Rotar INMO3D_ADMIN_TOKEN invalida todas las sesiones. */
export function logout(req, res) {
    if (!sameOrigin(req)) throw Object.assign(new Error('Origen no permitido.'), { status: 403 });
    res.setHeader('set-cookie', sessionCookie('', 0));
}
