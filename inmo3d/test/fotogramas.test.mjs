import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nitidez, elegir, opcionDesconocida, cuantosCuadros } from '../tools/fotogramas.mjs';

const ANCHO = 160, ALTO = 120;

/** Un cuadro con detalle: tablero de ajedrez fino. */
function nitido() {
    const g = new Uint8Array(ANCHO * ALTO);
    for (let y = 0; y < ALTO; y++) {
        for (let x = 0; x < ANCHO; x++) g[y * ANCHO + x] = (x >> 1) + (y >> 1) & 1 ? 230 : 25;
    }
    return g;
}

/** El mismo cuadro movido: un desenfoque por promedio de los vecinos. */
function movido(veces = 6) {
    let g = nitido();
    for (let v = 0; v < veces; v++) {
        const out = new Uint8Array(g.length);
        for (let y = 1; y < ALTO - 1; y++) {
            for (let x = 1; x < ANCHO - 1; x++) {
                const i = y * ANCHO + x;
                out[i] = (g[i] + g[i - 1] + g[i + 1] + g[i - ANCHO] + g[i + ANCHO]) / 5;
            }
        }
        g = out;
    }
    return g;
}

test('la nitidez distingue un cuadro con detalle de uno movido', () => {
    const a = nitidez(nitido());
    const b = nitidez(movido());
    assert.ok(a > b * 10, `el nítido (${a.toFixed(0)}) tiene que superar por lejos al movido (${b.toFixed(0)})`);
    assert.ok(nitidez(new Uint8Array(ANCHO * ALTO)) < 1, 'un cuadro liso no tiene detalle');
});

test('elegir se queda con el mejor de cada tramo y descarta lo movido', () => {
    // 100 cuadros: uno nítido cada cinco, el resto borroso.
    const puntajes = Array.from({ length: 100 }, (_, i) => (i % 5 === 0 ? 900 : 30));
    const elegidos = elegir(puntajes, 20);
    assert.equal(elegidos.length, 20);
    assert.ok(elegidos.every(i => i % 5 === 0), 'sólo tendría que quedarse con los nítidos');
});

test('si el video entero está movido, devuelve algo igual', () => {
    // Nada supera el piso, pero quedarse sin cuadros sería peor que intentar.
    const elegidos = elegir(Array.from({ length: 60 }, () => 12), 20);
    assert.equal(elegidos.length, 20, 'mejor intentar con lo que hay que no devolver nada');
});

test('un video corto entrega todos sus cuadros', () => {
    const elegidos = elegir([500, 480, 520], 80);
    assert.equal(elegidos.length, 3);
});

test('la cantidad de cuadros sale de cuánto dura el video', () => {
    // Con una cifra fija, un video largo queda ralo: medio segundo de caminata entre toma y
    // toma alcanza para que no compartan nada, y ahí es donde se parte la reconstrucción.
    assert.ok(cuantosCuadros(301) > 120, `50 s merecen más de 120 cuadros, no ${cuantosCuadros(301)}`);
    assert.equal(cuantosCuadros(60), 60, 'pero un video corto no baja del piso');
    assert.equal(cuantosCuadros(6000), 200, 'y uno larguísimo tiene techo: comparar crece al cuadrado');
});

test('reconoce cuando ffmpeg no entiende una opción', () => {
    // Las versiones nuevas sacaron `-vsync` y las viejas no tienen `-fps_mode`: extraer()
    // prueba una y cae a la otra, pero sólo si sabe distinguir ese error de uno real.
    for (const m of ['Unrecognized option \'vsync\'.', 'Option not found', 'Unknown option fps_mode']) {
        assert.ok(opcionDesconocida(m), `tendría que reconocer: ${m}`);
    }
    assert.ok(!opcionDesconocida('No such file or directory'), 'un video que falta no es una opción vieja');
    assert.ok(!opcionDesconocida(undefined), 'sin mensaje no se asume nada');
});
