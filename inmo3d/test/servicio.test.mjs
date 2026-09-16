// El instalador del servicio se corre una sola vez y en una máquina que no es esta, así que
// lo que se puede probar acá hay que probarlo. Un plist mal formado es el peor caso: launchd
// no se queja, simplemente lo ignora, y el worker no arranca nunca sin decir por qué.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armarPlist } from '../tools/servicio.mjs';

const ejemplo = () => armarPlist({
    nodo: '/opt/homebrew/bin/node',
    script: '/Users/alguien/Playcanvas-engine/inmo3d/tools/worker.mjs',
    dir: '/Users/alguien/Playcanvas-engine/inmo3d',
    ruta: '/opt/homebrew/bin:/usr/bin',
    log: '/Users/alguien/Library/Logs/inmo3d-worker.log'
});

test('el plist tiene lo que launchd necesita para levantar el worker solo', () => {
    const p = ejemplo();
    assert.match(p, /^<\?xml version="1\.0"/, 'sin la cabecera XML no lo lee');
    assert.match(p, /<plist version="1\.0">[\s\S]*<\/plist>/, 'y el documento tiene que cerrar');
    assert.match(p, /<key>RunAtLoad<\/key><true\/>/, 'RunAtLoad es lo que lo arranca al prender la Mac');
    assert.match(p, /<key>KeepAlive<\/key><true\/>/, 'KeepAlive es lo que lo vuelve a levantar si se cae');
    assert.match(p, /tools\/worker\.mjs/, 'y tiene que apuntar al worker');
    // Sin el PATH de la terminal, el servicio no encuentra colmap ni ffmpeg y todo falla
    // en el primer paso, con un mensaje que no dice nada de esto.
    assert.match(p, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
});

test('una ruta con caracteres raros no rompe el XML', () => {
    // Las carpetas de la gente tienen de todo: "Documentos & Fotos", "<borrador>", acentos.
    const p = armarPlist({
        nodo: '/usr/bin/node',
        script: '/Users/a/Documentos & Fotos/<v2>/worker.mjs',
        dir: '/Users/a/Documentos & Fotos',
        ruta: '/usr/bin',
        log: '/tmp/x.log'
    });
    assert.match(p, /Documentos &amp; Fotos/, 'el & tiene que ir escapado');
    assert.match(p, /&lt;v2&gt;/, 'y los signos de menor y mayor también');
    assert.doesNotMatch(p, /&(?!amp;|lt;|gt;)/, 'no puede quedar ningún & suelto: eso rompe el archivo');
    assert.doesNotMatch(p, /<string>[^<]*<(?!\/string>)/, 'ni un < adentro de un valor');
});

test('el plist no lleva la clave adentro', () => {
    // Los archivos de LaunchAgents los puede leer cualquiera que use la máquina; la clave
    // vive en .env, que queda con permisos de sólo el dueño.
    const p = armarPlist({
        nodo: '/usr/bin/node', script: '/a/worker.mjs', dir: '/a', ruta: '/usr/bin', log: '/tmp/x.log'
    });
    assert.doesNotMatch(p, /INMO3D_ADMIN_TOKEN|INMO3D_URL/, 'ninguna credencial tendría que aparecer acá');
});
