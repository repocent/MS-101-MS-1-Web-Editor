const fs = require('fs');

const MAGIC = [0x23, 0x98, 0x54, 0x76];
const STEP_OFFSET = 44;
const STEP_SIZE = 8;
const MAX_STEPS = 64; 
const MIN_NOTE = 36;
const MAX_NOTE = 63;
let numSteps = 16;
let stepCountInput = null;

function parseSeq(buffer) {
    const data = new Uint8Array(buffer);

    for (let i = 0; i < 4; i++) {
        if (data[i] !== MAGIC[i]) {
            throw new Error('Foutieve magic bytes in .seq bestand');
        }
    }

    const inferredSteps = Math.floor((data.length - STEP_OFFSET) / STEP_SIZE);
    if (inferredSteps < 1) {
        throw new Error(`Bestand is te klein`);
    }
    numSteps = Math.max(1, Math.min(MAX_STEPS, inferredSteps));
    if (stepCountInput) stepCountInput.value = numSteps;

    const steps = [];
    for (let i = 0; i < numSteps; i++) {
        const off = STEP_OFFSET + i * STEP_SIZE;
        let octave = data[off];
        let semi = data[off + 1];
        const gate = data[off + 2];
        const flags = data[off + 6];

        if (semi >= 12) {
            octave += 1;
            semi -= 12;
        }

        const midiNote = (octave + 1) * 12 + semi;
        
        const isRest = (flags & 0x08) !== 0;
        const isTie = (flags & 0x01) !== 0;
        const isAccent = (flags & 0x04) !== 0;
        const isSlide = (gate === 0x07);

        let type = 'play';
        if (isRest) type = 'rest';
        else if (isTie) type = 'tie';

        steps.push({
            type,
            note: Math.max(MIN_NOTE, Math.min(MAX_NOTE, midiNote)),
            accent: isAccent,
            slide: isSlide,
        });
    }

    return steps;
}

const buf = fs.readFileSync('32test.seq');
const arr = new Uint8Array(buf).buffer;
const steps = parseSeq(arr);
console.log('inferred numSteps:', numSteps);
console.log('steps array length:', steps.length);
