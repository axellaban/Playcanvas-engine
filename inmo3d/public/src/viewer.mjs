// Visor 3D: carga la nube de gaussians de la propiedad y da las dos formas de recorrerla
// que pide el rubro inmobiliario: órbita (ver la casa desde afuera) y caminata tipo Matterport
// (click en el piso = teletransporte). Encima montamos medición, hotspots y captura para la IA.
import {
    AppBase, AppOptions, Asset, CameraComponentSystem, Color, ContainerHandler, Entity,
    FILLMODE_NONE, GSplatComponentSystem, GSplatHandler, Keyboard, LightComponentSystem, Mouse,
    Picker, RESOLUTION_AUTO, RenderComponentSystem, ScriptComponentSystem, ScriptHandler,
    TONEMAP_ACES, TextureHandler, TouchDevice, Vec2, Vec3, XRSPACE_LOCALFLOOR, XRTYPE_VR,
    createGraphicsDevice
} from 'playcanvas';
import { CameraControls } from 'playcanvas/scripts/esm/camera-controls.mjs';

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
    app.scene.exposure = scene.exposure ?? 1;

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

    const aabb = splat.gsplat.customAabb;
    const center = aabb ? aabb.center.clone() : new Vec3();
    const radius = aabb ? Math.max(aabb.halfExtents.length(), 1) : 5;

    // ------------------------------------------------------------------ cámara
    const camera = new Entity('camera');
    camera.addComponent('camera', {
        clearColor: new Color(0.05, 0.06, 0.08),
        toneMapping: TONEMAP_ACES,
        fov: 70,
        farClip: Math.max(radius * 12, 200)
    });
    camera.setPosition(center.x + radius * 1.4, center.y + radius * 0.5, center.z + radius * 1.4);
    camera.lookAt(center);
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
        floorY: scene.floorY ?? (aabb ? aabb.getMin().y + 0.02 : 0),
        eyeHeight: scene.eyeHeight ?? 1.62,
        metersPerUnit: scene.metersPerUnit ?? 1,
        autoRotate: !!scene.autoRotate,
        tween: null,
        walk: { yaw: 0, pitch: 0, keys: new Set() }
    };

    applyTransform(scene);

    function applyTransform(s = {}) {
        splat.setLocalEulerAngles(s.pitch ?? 0, s.yaw ?? 0, s.roll ?? 0);
        const k = s.scale ?? 1;
        splat.setLocalScale(k, k, k);
    }

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
    async function pickWorld(clientX, clientY, intentos = 3) {
        const rect = canvas.getBoundingClientRect();
        const s = 0.25;   // a cuarto de resolución: alcanza y sobra, y es 16x más barato
        const x = (clientX - rect.left) * s;
        const y = (clientY - rect.top) * s;
        for (let i = 0; i < intentos; i++) {
            if (i) await nextFrame();
            picker.resize(Math.max(1, rect.width * s), Math.max(1, rect.height * s));
            picker.prepare(camera.camera, app.scene, [app.scene.layers.getLayerByName('World')]);
            const p = await picker.getWorldPointAsync(x, y);
            if (p) return p;
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
        } else if (state.autoRotate && controls.enabled) {
            const p = camera.getPosition().clone().sub(center);
            const a = 0.12 * dt;
            const x = p.x * Math.cos(a) - p.z * Math.sin(a);
            const z = p.x * Math.sin(a) + p.z * Math.cos(a);
            camera.setPosition(center.x + x, camera.getPosition().y, center.z + z);
            camera.lookAt(center);
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
        setExposure: (v) => {
            app.scene.exposure = v;
        },
        setFloor: (y) => {
            state.floorY = y;
        },
        setEyeHeight: (h) => {
            state.eyeHeight = h;
        },
        setMeters: (m) => {
            state.metersPerUnit = m;
        },
        setAutoRotate: (b) => {
            state.autoRotate = b;
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
