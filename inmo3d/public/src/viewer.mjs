// Visor 3D: carga la nube de gaussians de la propiedad y da las dos formas de recorrerla
// que pide el rubro inmobiliario: órbita (ver la casa desde afuera) y caminata tipo Matterport
// (click en el piso = teletransporte). Encima montamos medición, hotspots y captura para la IA.
import {
    AppBase, AppOptions, Asset, BoundingBox, CameraComponentSystem, Color, ContainerHandler, Entity,
    FILLMODE_NONE, GSplatComponentSystem, GSplatHandler, Keyboard, LightComponentSystem, Mouse,
    Picker, RESOLUTION_AUTO, RenderComponentSystem, ScriptComponentSystem, ScriptHandler,
    TONEMAP_ACES, TextureHandler, TouchDevice, Vec2, Vec3, XRSPACE_LOCALFLOOR, XRTYPE_VR,
    createGraphicsDevice
} from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';
import { cajaRobusta } from './encuadre.mjs';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const v3 = a => new Vec3(a[0], a[1], a[2]);
export const arr = v => [v.x, v.y, v.z];

/**
 * Descarga el splat mostrando progreso real. El motor elige el parser por la extensión
 * del `filename`, no por la URL, así que podemos servirle los bytes ya descargados y
 * seguir eligiendo bien el formato. Si la descarga manual falla (CORS, por ejemplo),
 * se devuelve la URL original y que la cargue el motor por su cuenta.
 */
async function download(url, onProgress) {
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const total = Number(res.headers.get('content-length')) || 0;
        if (!res.body) return { url, total };
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            onProgress?.(received, total);
        }
        const blob = new Blob(chunks);
        return { url: URL.createObjectURL(blob), total: received, revoke: true };
    } catch {
        return { url, total: 0 };
    }
}

export async function createViewer({ canvas, splatUrl, scene = {}, gpu = 'webgl2', onProgress }) {
    const device = await createGraphicsDevice(canvas, {
        deviceTypes: gpu === 'webgpu' ? ['webgpu', 'webgl2'] : ['webgl2'],
        // Los splats no se benefician del antialiasing y cuesta caro.
        antialias: false
    });
    device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

    const options = new AppOptions();
    options.graphicsDevice = device;
    options.mouse = new Mouse(document.body);
    options.touch = new TouchDevice(document.body);
    options.keyboard = new Keyboard(window);
    options.componentSystems = [
        RenderComponentSystem, CameraComponentSystem, LightComponentSystem,
        ScriptComponentSystem, GSplatComponentSystem
    ];
    options.resourceHandlers = [TextureHandler, ContainerHandler, ScriptHandler, GSplatHandler];

    const app = new AppBase(canvas);
    app.init(options);
    app.setCanvasFillMode(FILLMODE_NONE);
    app.setCanvasResolution(RESOLUTION_AUTO);

    const resize = () => {
        const r = canvas.parentElement.getBoundingClientRect();
        app.resizeCanvas(r.width, r.height);
        canvas.style.width = `${r.width}px`;
        canvas.style.height = `${r.height}px`;
    };
    new ResizeObserver(resize).observe(canvas.parentElement);
    resize();

    // Los ids por splat son los que permiten "tocar" la nube con el Picker.
    app.scene.gsplat.enableIds = true;
    app.scene.gsplat.alphaClip = 0.2;

    // ------------------------------------------------------------------ splat
    const file = await download(splatUrl, onProgress);
    // El nombre conserva la extensión real: es lo que usa el motor para elegir el parser.
    const filename = splatUrl.split('?')[0].split('/').pop() || 'model.sog';
    const asset = new Asset('splat', 'gsplat', { url: file.url, filename });
    app.assets.add(asset);
    try {
        await new Promise((resolve, reject) => {
            asset.once('load', resolve);
            asset.once('error', e => reject(new Error(`No pude abrir la escena 3D: ${e}`)));
            app.assets.load(asset);
        });
    } finally {
        if (file.revoke) URL.revokeObjectURL(file.url);
    }

    const splat = new Entity('splat');
    splat.addComponent('gsplat', { asset, castShadows: false });
    app.root.addChild(splat);

    function applyTransform(s = {}) {
        splat.setLocalEulerAngles(s.pitch ?? 0, s.yaw ?? 0, s.roll ?? 0);
        const k = s.scale ?? 1;
        splat.setLocalScale(k, k, k);
    }

    // Se endereza la escena antes de encuadrarla: si alguien la giró desde el panel, la cámara
    // tiene que mirar la casa como quedó, no como venía. Antes se orientaba después y una casa
    // enderezada volvía a abrirse con el encuadre de la torcida.
    applyTransform(scene);
    const crudo = splat.gsplat.customAabb;
    // Las posiciones salen del asset que cargamos acá arriba y no de `splat.gsplat.asset`:
    // esa propiedad devuelve el número de identificación del asset, no el asset, así que de
    // ahí no cuelga nada y el encuadre se quedaba en silencio con la caja cruda.
    const caja = cajaRobusta(asset.resource?.centers);
    const local = new BoundingBox();
    if (caja) local.setMinMax(new Vec3(...caja.min), new Vec3(...caja.max));
    const aabb = new BoundingBox();
    if (caja || crudo) aabb.setFromTransformedAabb(caja ? local : crudo, splat.getWorldTransform());
    else aabb.halfExtents.set(5, 5, 5);
    const center = aabb.center.clone();
    const radius = Math.max(aabb.halfExtents.length(), 1);
    // Se calculan acá porque los usan dos cosas: dónde arranca la cámara y el modo caminar.
    const piso = scene.floorY ?? aabb.getMin().y + 0.02;
    const ojos = (scene.eyeHeight ?? 1.62) / (scene.metersPerUnit || 1);
    // Lo lejano se sigue dibujando: el plano de corte mira el box crudo, no el de la casa.
    const alcance = crudo ? Math.max(crudo.halfExtents.length() * 4, radius * 12) : radius * 12;

    // ------------------------------------------------------------------ cámara
    const camera = new Entity('camera');
    camera.addComponent('camera', {
        clearColor: new Color(0.05, 0.06, 0.08),
        toneMapping: TONEMAP_ACES,
        fov: 70,
        farClip: Math.max(alcance, 200)
    });
    // Un escaneo de interior mirado desde afuera no muestra la casa: muestra el revés de las
    // paredes. Matterport, Polycam y Zillow arrancan los tres adentro y parados. Acá igual: la
    // cámara empieza a la altura de los ojos, corrida hacia una punta y mirando a lo largo del
    // ambiente, que es lo que ve alguien que abre la puerta y entra.
    const aLoLargo = aabb.halfExtents.x >= aabb.halfExtents.z ?
        [aabb.halfExtents.x * 0.82, 0] : [0, aabb.halfExtents.z * 0.82];
    const alturaOjos = piso + Math.min(ojos, aabb.halfExtents.y * 1.7);
    camera.setPosition(center.x - aLoLargo[0], alturaOjos, center.z - aLoLargo[1]);
    camera.lookAt(center.x, alturaOjos, center.z);
    camera.addComponent('script');
    app.root.addChild(camera);

    const controls = camera.script.create(CameraControls, {
        properties: {
            enableFly: true,
            enableOrbit: true,
            enablePan: true,
            focusPoint: center,
            zoomRange: new Vec2(radius * 0.05, radius * 8),
            pitchRange: new Vec2(-89, 89),
            moveSpeed: radius * 0.35
        }
    });

    app.start();

    const picker = new Picker(app, 1, 1, true);
    const state = {
        mode: 'orbita',
        floorY: piso,
        eyeHeight: scene.eyeHeight ?? 1.62,
        metersPerUnit: scene.metersPerUnit ?? 1,
        tween: null,
        walk: { yaw: 0, pitch: 0, keys: new Set() }
    };

    // ------------------------------------------------------------------ picking
    const nextFrame = () => new Promise((resolve) => {
        app.once('postrender', resolve);
    });

    /**
     * Devuelve el punto 3D bajo el cursor, o null si ahí no hay superficie.
     *
     * El Picker dibuja el buffer de ids y después lo lee: si el cuadro todavía no se
     * dibujó, la lectura vuelve vacía aunque ahí sí haya superficie. Pasaba una de cada
     * varias veces y hacía perder el primer punto de una medición, así que reintenta.
     */
    // Alrededor del píxel exacto, en espiral: primero el centro, después los vecinos.
    const VECINOS = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [3, 3], [-3, 3], [3, -3], [-3, -3]];

    async function pickWorld(clientX, clientY, intentos = 2) {
        const rect = canvas.getBoundingClientRect();
        const s = 0.25;   // a cuarto de resolución: alcanza y sobra, y es 16x más barato
        const x = (clientX - rect.left) * s;
        const y = (clientY - rect.top) * s;
        const w = Math.max(1, rect.width * s), hgt = Math.max(1, rect.height * s);
        for (let i = 0; i < intentos; i++) {
            if (i) await nextFrame();
            picker.resize(w, hgt);
            picker.prepare(camera.camera, app.scene, [app.scene.layers.getLayerByName('World')]);
            for (const [dx, dy] of VECINOS) {
                const px = x + dx, py = y + dy;
                if (px < 0 || py < 0 || px >= w || py >= hgt) continue;
                const p = await picker.getWorldPointAsync(px, py);
                if (p) return p;
            }
        }
        return null;
    }

    function worldToScreen(p) {
        const s = camera.camera.worldToScreen(p);
        return { x: s.x, y: s.y, visible: s.z > 0 };
    }

    // ------------------------------------------------------------------ movimiento
    function tweenTo(position, lookAt, ms = 900) {
        const from = camera.getPosition().clone();
        const fromLook = from.clone().add(camera.forward.clone().mulScalar(from.distance(lookAt) || 1));
        state.tween = { from, fromLook, to: position.clone(), toLook: lookAt.clone(), t: 0, ms };
        controls.enabled = false;
    }

    /**
     * Deriva pitch/yaw del vector de dirección en vez de descomponer los ángulos de Euler:
     * la descomposición tiene dos soluciones equivalentes y a veces devuelve la que mira al techo.
     */
    function syncWalkFromCamera() {
        const f = camera.forward;
        state.walk.pitch = clamp(Math.asin(clamp(f.y, -1, 1)) * 180 / Math.PI, -85, 85);
        state.walk.yaw = Math.atan2(-f.x, -f.z) * 180 / Math.PI;
    }

    function endTween() {
        const { to, toLook } = state.tween;
        state.tween = null;
        camera.setPosition(to);
        camera.lookAt(toLook);
        if (state.mode === 'orbita') {
            controls.enabled = true;
            controls.reset(toLook, to);
        } else {
            syncWalkFromCamera();
        }
    }

    app.on('update', (dt) => {
        if (state.tween) {
            const tw = state.tween;
            tw.t = Math.min(1, tw.t + (dt * 1000) / tw.ms);
            const k = easeInOut(tw.t);
            camera.setPosition(
                tw.from.x + (tw.to.x - tw.from.x) * k,
                tw.from.y + (tw.to.y - tw.from.y) * k,
                tw.from.z + (tw.to.z - tw.from.z) * k
            );
            camera.lookAt(
                tw.fromLook.x + (tw.toLook.x - tw.fromLook.x) * k,
                tw.fromLook.y + (tw.toLook.y - tw.fromLook.y) * k,
                tw.fromLook.z + (tw.toLook.z - tw.fromLook.z) * k
            );
            if (tw.t >= 1) endTween();
            return;
        }

        if (state.mode === 'caminar') {
            const { keys, yaw, pitch } = state.walk;
            const step = (keys.has('shiftleft') ? 3.4 : 1.5) * dt / (state.metersPerUnit || 1);
            const fwd = camera.forward.clone();
            fwd.y = 0;
            fwd.normalize();
            const right = camera.right.clone();
            right.y = 0;
            right.normalize();
            const move = new Vec3();
            if (keys.has('keyw') || keys.has('arrowup')) move.add(fwd);
            if (keys.has('keys') || keys.has('arrowdown')) move.sub(fwd);
            if (keys.has('keyd') || keys.has('arrowright')) move.add(right);
            if (keys.has('keya') || keys.has('arrowleft')) move.sub(right);
            const p = camera.getPosition().clone();
            if (move.length() > 0) p.add(move.normalize().mulScalar(step));
            p.y = state.floorY + state.eyeHeight / (state.metersPerUnit || 1);
            camera.setPosition(p);
            camera.setEulerAngles(pitch, yaw, 0);
        }
    });

    // Mirar alrededor mientras se camina (arrastrando, como en cualquier tour).
    let dragging = null;
    canvas.addEventListener('pointerdown', (e) => {
        if (state.mode !== 'caminar') return;
        dragging = { x: e.clientX, y: e.clientY, moved: 0 };
        canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
        if (!dragging || state.mode !== 'caminar') return;
        const dx = e.clientX - dragging.x;
        const dy = e.clientY - dragging.y;
        dragging.x = e.clientX;
        dragging.y = e.clientY;
        dragging.moved += Math.abs(dx) + Math.abs(dy);
        state.walk.yaw -= dx * 0.2;
        state.walk.pitch = clamp(state.walk.pitch - dy * 0.2, -85, 85);
    });
    canvas.addEventListener('pointerup', () => {
        dragging = null;
    });

    window.addEventListener('keydown', (e) => {
        if (e.target.matches('input, textarea')) return;
        state.walk.keys.add(e.code.toLowerCase());
    });
    window.addEventListener('keyup', e => state.walk.keys.delete(e.code.toLowerCase()));
    window.addEventListener('blur', () => state.walk.keys.clear());

    function setMode(mode) {
        state.mode = mode;
        if (mode === 'caminar') {
            controls.enabled = false;
            syncWalkFromCamera();
        } else {
            controls.enabled = true;
            const look = camera.getPosition().clone().add(camera.forward.clone().mulScalar(radius * 0.5));
            controls.reset(look, camera.getPosition());
        }
        return mode;
    }

    /**
     * Teletransporte: caés parado sobre el punto que clickeaste, a la altura de los ojos.
     * @param point
     */
    function teleport(point) {
        const eye = state.eyeHeight / (state.metersPerUnit || 1);
        const to = new Vec3(point.x, state.floorY + eye, point.z);
        const look = to.clone().add(camera.forward.clone().mulScalar(radius * 0.4));
        look.y = to.y;
        tweenTo(to, look, 650);
    }

    function goTo(wp, ms = 1100) {
        tweenTo(v3(wp.pos), v3(wp.look ?? wp.pos), ms);
    }

    /**
     * Captura el frame ya dibujado: es lo que mandamos a la IA para el staging.
     * @param quality
     */
    function screenshot(quality = 0.92) {
        return new Promise((resolve) => {
            app.once('postrender', () => resolve(canvas.toDataURL('image/jpeg', quality)));
            app.renderNextFrame = true;
        });
    }

    function startVR() {
        if (!app.xr?.isAvailable(XRTYPE_VR)) return Promise.reject(new Error('Este dispositivo no tiene VR disponible.'));
        return new Promise((resolve, reject) => {
            camera.camera.startXr(XRTYPE_VR, XRSPACE_LOCALFLOOR, {
                callback: err => (err ? reject(err) : resolve())
            });
        });
    }

    return {
        app,
        camera,
        splat,
        controls,
        state,
        center,
        radius,
        aabb,
        pickWorld,
        worldToScreen,
        setMode,
        teleport,
        goTo,
        screenshot,
        startVR,
        applyTransform,
        vrAvailable: () => !!app.xr?.isAvailable(XRTYPE_VR),
        setFloor: (y) => {
            state.floorY = y;
        },
        setEyeHeight: (h) => {
            state.eyeHeight = h;
        },
        setMeters: (m) => {
            state.metersPerUnit = m;
        },
        /**
         * Distancia real entre dos puntos, aplicando la calibración métrica.
         * @param a
         * @param b
         */
        distance: (a, b) => v3(a).distance(v3(b)) * (state.metersPerUnit || 1),
        drawSegment: (a, b, color) => app.drawLine(v3(a), v3(b), color, false),
        destroy: () => app.destroy()
    };
}
