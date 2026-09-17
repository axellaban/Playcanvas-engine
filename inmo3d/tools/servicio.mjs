#!/usr/bin/env node
// Deja el worker corriendo como servicio de la Mac: arranca solo al prender la máquina,
// vuelve a levantarse si se cae, y sobrevive a los reinicios. Se corre una sola vez.
//
//   INMO3D_URL=https://tu-app.vercel.app INMO3D_ADMIN_TOKEN=tuclave npm run worker:install
//   npm run worker:uninstall
//
// La clave no va adentro del plist: los archivos de LaunchAgents los puede leer cualquiera
// que use la máquina. Va a inmo3d/.env, que es de lectura exclusiva del dueño y que el
// worker ya sabe leer solo.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const correr = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Dos servicios con la misma forma. El worker hace el trabajo pesado; la app es la pantalla
// que se abre desde la Mac y desde el celular. Antes la app vivía sólo mientras hubiera una
// terminal abierta, y cerrar esa ventana la apagaba sin avisar.
const SERVICIOS = {
    worker: {
        etiqueta: 'com.inmo3d.worker',
        script: 'tools/worker.mjs',
        log: 'inmo3d-worker.log',
        // El worker habla con la app: necesita saber dónde está y con qué clave entrar.
        pideDestino: true,
        listo: url => `El worker ya está corriendo y arranca solo cada vez que prendas la Mac.

  App:      ${url}`
    },
    app: {
        etiqueta: 'com.inmo3d.app',
        script: 'server/index.mjs',
        log: 'inmo3d-app.log',
        pideDestino: false,
        listo: () => `La app ya está corriendo y arranca sola cada vez que prendas la Mac.
No hace falta dejar ninguna terminal abierta.

  Desde la Mac:      http://localhost:${process.env.PORT || 3113}
  Desde el celular:  fijate la dirección de la wifi en el registro`
    }
};

const rutaPlist = etiqueta => path.join(os.homedir(), 'Library', 'LaunchAgents', `${etiqueta}.plist`);
const rutaLog = nombre => path.join(os.homedir(), 'Library', 'Logs', nombre);

const salir = (mensaje) => {
    console.error(mensaje);
    process.exit(1);
};

/** Lee el .env que ya usa el worker, para no pedir de nuevo lo que ya está guardado. */
async function leerEnv() {
    const texto = await fs.readFile(path.join(ROOT, '.env'), 'utf8').catch(() => '');
    const valores = {};
    for (const linea of texto.split('\n')) {
        const m = linea.match(/^\s*([A-Z0-9_]+)=(.*)$/);
        if (m) valores[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return valores;
}

/** Guarda una clave en el .env sin pisar lo demás, y deja el archivo sólo para el dueño. */
async function guardarEnv(nuevos) {
    const archivo = path.join(ROOT, '.env');
    const texto = await fs.readFile(archivo, 'utf8').catch(() => '');
    const lineas = texto.split('\n').filter(l => l.trim());
    for (const [clave, valor] of Object.entries(nuevos)) {
        const i = lineas.findIndex(l => l.startsWith(`${clave}=`));
        if (i >= 0) lineas[i] = `${clave}=${valor}`;
        else lineas.push(`${clave}=${valor}`);
    }
    await fs.writeFile(archivo, `${lineas.join('\n')}\n`, { mode: 0o600 });
    await fs.chmod(archivo, 0o600);
}

const escapar = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * El archivo que le describe el servicio a macOS. Un plist mal formado no da error: launchd
 * lo ignora en silencio y el worker no arranca nunca, así que conviene poder probarlo.
 * Acá no va ninguna credencial: estos archivos los lee cualquiera que use la máquina.
 */
export const armarPlist = ({ etiqueta = 'com.inmo3d.worker', nodo, script, dir, ruta, log }) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapar(etiqueta)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapar(nodo)}</string>
    <string>${escapar(script)}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapar(dir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapar(ruta)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escapar(log)}</string>
  <key>StandardErrorPath</key><string>${escapar(log)}</string>
</dict>
</plist>
`;

async function instalar(cual) {
    const servicio = SERVICIOS[cual];
    if (os.platform() !== 'darwin') {
        salir('Esto instala un servicio de macOS. En otro sistema, corré `npm run worker` a mano.');
    }
    const PLIST = rutaPlist(servicio.etiqueta);
    const LOG = rutaLog(servicio.log);
    let url = '';
    if (servicio.pideDestino) {
        const env = await leerEnv();
        url = process.env.INMO3D_URL || env.INMO3D_URL;
        const token = process.env.INMO3D_ADMIN_TOKEN || env.INMO3D_ADMIN_TOKEN;
        if (!url || !token) {
            salir('Falta la dirección de la app o la clave. Corré:\n\n' +
                '  INMO3D_URL=https://tu-app.vercel.app INMO3D_ADMIN_TOKEN=tuclave npm run worker:install\n');
        }
        await guardarEnv({ INMO3D_URL: url, INMO3D_ADMIN_TOKEN: token });
    }

    // El PATH de un servicio es mínimo y no incluye Homebrew: sin esto no encuentra ni
    // colmap ni ffmpeg. Le pasamos el de la terminal desde donde se instala, que sí los tiene.
    const plist = armarPlist({
        etiqueta: servicio.etiqueta,
        nodo: process.execPath,
        script: path.join(ROOT, ...servicio.script.split('/')),
        dir: ROOT,
        ruta: process.env.PATH || '/usr/bin:/bin',
        log: LOG
    });
    await fs.mkdir(path.dirname(PLIST), { recursive: true });
    await fs.mkdir(path.dirname(LOG), { recursive: true });
    await fs.writeFile(PLIST, plist);

    // Si ya estaba instalado hay que descargarlo antes, si no el nuevo no toma efecto.
    await correr('launchctl', ['unload', PLIST]).catch(() => {});
    await correr('launchctl', ['load', '-w', PLIST]);

    console.log(`Listo. ${servicio.listo(url)}

  Registro: ${LOG}

Para ver cómo va:  tail -f "${LOG}"
Para sacarlo:  npm run ${cual === 'app' ? 'app' : 'worker'}:uninstall`);
}

async function desinstalar(cual) {
    const PLIST = rutaPlist(SERVICIOS[cual].etiqueta);
    await correr('launchctl', ['unload', '-w', PLIST]).catch(() => {});
    await fs.rm(PLIST, { force: true });
    console.log(`Servicio "${cual}" sacado. Ya no arranca solo.`);
}

// Sólo actúa cuando se lo corre de verdad; importarlo (por ejemplo desde un test) no hace nada.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    // Se lo llama como:  servicio.mjs [app|worker] [uninstall]
    const cual = process.argv.includes('app') ? 'app' : 'worker';
    await (process.argv.includes('uninstall') ? desinstalar(cual) : instalar(cual));
}
