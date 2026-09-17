// Rescatar es la última red: el entrenamiento son horas y la subida son segundos, pero si esos
// segundos fallan —se cortó internet, el almacenamiento se quedó sin cuota— el trabajo está
// hecho y guardado y no hay que perderlo. Si esta búsqueda no encuentra el archivo, o elige el
// equivocado, la red no sirve de nada y las horas se tiran igual.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buscar, elegir, tituloDesde } from '../tools/rescatar.mjs';

const escribir = async (archivo, texto = 'x') => {
    await fs.mkdir(path.dirname(archivo), { recursive: true });
    await fs.writeFile(archivo, texto);
};

test('rescate', async (t) => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'inmo3d-rescate-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));

    await t.test('encuentra el modelo aunque esté hondo', async () => {
        // Así lo deja el worker: trabajo / salida-denso / model.sog
        await escribir(path.join(base, 'casa-123', 'salida-denso', 'model.sog'), 'sog');
        const hallados = await buscar(base);
        assert.equal(hallados.length, 1);
        assert.match(hallados[0].archivo, /salida-denso[/\\]model\.sog$/);
        assert.equal(hallados[0].bytes, 3);
    });

    await t.test('no levanta cualquier archivo que ande por ahí', async () => {
        await escribir(path.join(base, 'casa-123', 'salida-denso', 'work', 'database.db'), 'no');
        await escribir(path.join(base, 'casa-123', 'recorrido.mp4'), 'no');
        await escribir(path.join(base, 'casa-123', 'fotos-denso', 'cuadro-0001.jpg'), 'no');
        const hallados = await buscar(base);
        assert.equal(hallados.length, 1, 'sólo el modelo');
    });

    await t.test('un archivo vacío no cuenta como rescate', async () => {
        // Pasa cuando el proceso se cortó justo mientras escribía: el archivo existe y no sirve.
        await escribir(path.join(base, 'casa-999', 'salida-normal', 'model.sog'), '');
        const hallados = await buscar(base);
        assert.equal(hallados.length, 1, 'el vacío no se ofrece como si fuera el trabajo hecho');
    });

    await t.test('no se va a recorrer el disco entero', async () => {
        const hondo = path.join(base, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'model.sog');
        await escribir(hondo, 'sog');
        assert.equal((await buscar(base, 3)).length, 1, 'con poca hondura no llega al de más abajo');
    });

    await t.test('en el temporal sólo entra a lo nuestro', async () => {
        // El temporal del sistema tiene miles de carpetas ajenas; meterse en todas sería
        // recorrer medio disco en cada rescate.
        const mio = path.join(os.tmpdir(), `inmo3d-prueba-${process.pid}`, 'model.sog');
        const ajeno = path.join(os.tmpdir(), `otracosa-${process.pid}`, 'model.sog');
        await escribir(mio, 'sog');
        await escribir(ajeno, 'sog');
        t.after(() => Promise.all([mio, ajeno].map(f => fs.rm(path.dirname(f), { recursive: true, force: true }))));
        const rutas = (await buscar(os.tmpdir(), 2)).map(f => f.archivo);
        assert.ok(rutas.includes(mio), 'tiene que encontrar el nuestro');
        assert.ok(!rutas.includes(ajeno), 'y no meterse en carpetas de otros programas');
    });
});

test('elegir se queda con el que sirve', () => {
    const f = (archivo, cuando) => ({ archivo, cuando: new Date(cuando) });
    // El .sog es el que el visor carga liviano; el .ply es el paso anterior y pesa diez veces
    // más. Si están los dos, va el .sog, aunque el .ply sea más nuevo por milisegundos.
    assert.equal(elegir([f('/a/model.ply', '2026-09-17T10:00:01Z'), f('/a/model.sog', '2026-09-17T10:00:00Z')]).archivo,
        '/a/model.sog');
    // Entre varios del mismo tipo, el más nuevo: es el de la última corrida.
    assert.equal(elegir([f('/a/model.sog', '2026-09-01T00:00:00Z'), f('/b/model.sog', '2026-09-17T00:00:00Z')]).archivo,
        '/b/model.sog');
    // Sin .sog, el .ply sirve igual: el visor también lo abre.
    assert.equal(elegir([f('/a/model.ply', '2026-09-17T00:00:00Z')]).archivo, '/a/model.ply');
    assert.equal(elegir([]), null);
});

test('el título sale de la carpeta del trabajo', () => {
    // Carpeta vieja, la del temporal: prefijo del programa y un sello al azar al final.
    assert.equal(tituloDesde('/var/folders/x/T/inmo3d-casa-en-almagro-bulnes-800-e4odZi/salida-denso/model.sog'),
        'casa en almagro bulnes 800');
    // Carpeta nueva: la propiedad y la fecha del pedido.
    assert.equal(tituloDesde(`${path.join('/home/ale/.inmo3d/trabajos/casa-en-almagro-bulnes-800-20260916')}/salida-denso/model.sog`),
        'casa en almagro bulnes 800');
    // Nunca devuelve vacío: sin nombre igual hay que poder rescatar.
    assert.equal(tituloDesde('/un/lugar/cualquiera/model.sog'), 'rescatada');
});
