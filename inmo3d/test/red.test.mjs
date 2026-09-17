// Sin la dirección de la Mac en la wifi, el camino del producto se corta en el primer paso: el
// video se graba con el celular, y el celular no entiende "localhost" —para él, localhost es él
// mismo—. Que el arranque imprima la dirección correcta es lo que hace que se pueda subir.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enLaRed } from '../server/red.mjs';

test('la dirección que sirve desde el celular', () => {
    const placas = {
        lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' },
            { family: 'IPv6', internal: true, address: '::1' }],
        en0: [{ family: 'IPv6', internal: false, address: 'fe80::1' },
            { family: 'IPv4', internal: false, address: '192.168.0.15' }],
        // Docker y las VPN dejan placas que existen pero por las que el celular no llega.
        bridge0: [{ family: 'IPv4', internal: false, address: '10.37.129.2' }]
    };
    const salida = enLaRed(placas);
    assert.ok(salida.includes('192.168.0.15'), 'la de la wifi tiene que estar');
    assert.ok(!salida.includes('127.0.0.1'), 'localhost no sirve desde otro aparato');
    assert.ok(!salida.some(d => d.includes(':')), 'las IPv6 no sirven para tipear a mano');
});

test('una máquina sin red no rompe el arranque', () => {
    // Sin wifi la app tiene que arrancar igual: se sigue usando desde la propia máquina.
    assert.deepEqual(enLaRed({}), []);
    assert.deepEqual(enLaRed({ lo0: undefined }), []);
});
