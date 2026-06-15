/* =======================================================
   Roland SH-101 Retro Synthesizer — Application Logic
   ======================================================= */

(() => {
    'use strict';

    // ---- Constants ----
    const MAGIC = [0x23, 0x98, 0x54, 0x76];
    const STEP_OFFSET = 44;
    const STEP_SIZE = 8;
    const MAX_STEPS = 64;  // Maximum supported steps
    
    // SH-101 note range C2 (36) to Eb4 (63)
    const MIN_NOTE = 36;
    const MAX_NOTE = 63;
    const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // List of note objects for select dropdowns
    const noteOptions = [];
    for (let n = MIN_NOTE; n <= MAX_NOTE; n++) {
        const octave = Math.floor(n / 12) - 1;
        const name = NOTE_NAMES[n % 12];
        noteOptions.push({ value: n, name: `${name}${octave}` });
    }

    // ---- State ----
    // numSteps is 16 or 32 — controlled by the 16/32 toggle buttons
    let numSteps = 64;

    function makeDefaultStep(i) {
        return {
            type: (i % 2 === 0) ? 'play' : 'rest',
            note: 48,
            accent: false,
            slide: false,
        };
    }

    let sequence = Array(numSteps).fill(null).map((_, i) => makeDefaultStep(i));
    
    let bpm = 120;
    let currentFileName = 'sequence';
    let isPlaying = false;
    let playbackStep = -1;
    
    // Audio Context & Nodes
    let audioCtx = null;
    let schedulerTimer = null;
    let nextStepTime = 0.0;
    let playStepIndex = 0;
    const lookahead = 25.0; // ms
    const scheduleAheadTime = 0.1; // seconds

    // ---- DOM Elements ----
    const stepCountInput = document.getElementById('stepCountInput');
    const seqPanelTitle = document.getElementById('seqPanelTitle');
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    const fileStatusBar = document.getElementById('fileStatusBar');
    const bpmInput = document.getElementById('bpmInput');
    const tempoDisplay = document.getElementById('tempoDisplay');
    const transposeInput = document.getElementById('transposeInput');
    const playBtn = document.getElementById('playBtn');
    const playLed = document.getElementById('playLed');
    const clearBtn = document.getElementById('clearBtn');
    const stepGrid = document.getElementById('stepGrid');
    const pianoRoll = document.getElementById('pianoRoll');
    const downloadSeqBtn = document.getElementById('downloadSeqBtn');
    const downloadMidiBtn = document.getElementById('downloadMidiBtn');
    const fileName = document.getElementById('fileName');
    const fileMeta = document.getElementById('fileMeta');
    const fileBadge = document.getElementById('fileBadge');
    const errorCard = document.getElementById('errorCard');
    const errorText = document.getElementById('errorText');

    // Synth Controls
    const lfoRate = document.getElementById('lfoRate');
    const lfoWave = document.getElementById('lfoWave');
    const vcoRange = document.getElementById('vcoRange');
    const pwMode = document.getElementById('pwMode');
    const pulseWidth = document.getElementById('pulseWidth');
    const mixSaw = document.getElementById('mixSaw');
    const mixPulse = document.getElementById('mixPulse');
    const mixSub = document.getElementById('mixSub');
    const mixNoise = document.getElementById('mixNoise');
    const subType = document.getElementById('subType');
    const vcfCutoff = document.getElementById('vcfCutoff');
    const vcfRes = document.getElementById('vcfRes');
    const vcfEnv = document.getElementById('vcfEnv');
    const vcfLfo = document.getElementById('vcfLfo');
    const vcfKey = document.getElementById('vcfKey');
    const vcaMode = document.getElementById('vcaMode');
    const envAttack = document.getElementById('envAttack');
    const envDecay = document.getElementById('envDecay');
    const envSustain = document.getElementById('envSustain');
    const envRelease = document.getElementById('envRelease');

    // ---- Web Audio SH-101 Voice Engine ----
    function initAudio() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }

    // White Noise Buffer Generator
    let noiseBuffer = null;
    function getNoiseBuffer() {
        if (noiseBuffer) return noiseBuffer;
        
        const bufferSize = 2 * audioCtx.sampleRate;
        noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        const data = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }
        return noiseBuffer;
    }

    // Play a note event with current synth parameters
    function playSynthNote(noteNum, time, duration, isAccent, isSlide) {
        initAudio();

        const oscSaw = audioCtx.createOscillator();
        const oscPulse = audioCtx.createOscillator();
        const oscSub = audioCtx.createOscillator();
        const noiseNode = audioCtx.createBufferSource();
        
        const sawGain = audioCtx.createGain();
        const pulseGain = audioCtx.createGain();
        const subGain = audioCtx.createGain();
        const noiseGain = audioCtx.createGain();
        const masterGain = audioCtx.createGain();
        const filter = audioCtx.createBiquadFilter();

        // 1. VCO Range octave shift
        const rangeVal = parseInt(vcoRange.value);
        let octaveShift = 0;
        if (rangeVal === 16) octaveShift = -12;
        else if (rangeVal === 8) octaveShift = 0;
        else if (rangeVal === 4) octaveShift = 12;
        else if (rangeVal === 2) octaveShift = 24;

        const baseFreq = Math.pow(2, ((noteNum + octaveShift) - 69) / 12) * 440;

        // 2. Setup Saw Oscillator
        oscSaw.type = 'sawtooth';
        oscSaw.frequency.setValueAtTime(baseFreq, time);
        
        // 3. Setup Pulse/Square Oscillator
        // A standard square wave is used. Pulse width is simulated via detune/offset if manual,
        // or LFO rate if LFO mode.
        oscPulse.type = 'square';
        oscPulse.frequency.setValueAtTime(baseFreq, time);
        if (pwMode.value === 'lfo') {
            const pwLfo = audioCtx.createOscillator();
            const pwLfoGain = audioCtx.createGain();
            pwLfo.frequency.value = parseFloat(lfoRate.value);
            pwLfoGain.gain.value = parseFloat(pulseWidth.value) * 0.2; // sweep depth
            pwLfo.connect(pwLfoGain);
            pwLfoGain.connect(oscPulse.detune);
            pwLfo.start(time);
            pwLfo.stop(time + duration + 1.0);
        } else if (pwMode.value === 'manual') {
            const detuneVal = (parseFloat(pulseWidth.value) - 50) * 0.4;
            oscPulse.detune.setValueAtTime(detuneVal, time);
        }

        // 4. Setup Sub Oscillator (1 or 2 octaves down)
        oscSub.type = 'square';
        let subFreq = baseFreq / 4; // default 2 oct down
        if (subType.value === '1sq') subFreq = baseFreq / 2;
        else if (subType.value === '2sq') subFreq = baseFreq / 4;
        else if (subType.value === '2pulse') subFreq = baseFreq / 4; // simulated as square
        oscSub.frequency.setValueAtTime(subFreq, time);

        // 5. Setup White Noise Source
        noiseNode.buffer = getNoiseBuffer();
        noiseNode.loop = true;

        // 6. Mixer Gains
        sawGain.gain.setValueAtTime(parseFloat(mixSaw.value) / 100 * 0.2, time);
        pulseGain.gain.setValueAtTime(parseFloat(mixPulse.value) / 100 * 0.2, time);
        subGain.gain.setValueAtTime(parseFloat(mixSub.value) / 100 * 0.22, time);
        noiseGain.gain.setValueAtTime(parseFloat(mixNoise.value) / 100 * 0.08, time);

        // Connect Mixer
        oscSaw.connect(sawGain);
        oscPulse.connect(pulseGain);
        oscSub.connect(subGain);
        noiseNode.connect(noiseGain);

        sawGain.connect(filter);
        pulseGain.connect(filter);
        subGain.connect(filter);
        noiseGain.connect(filter);

        // 7. VCF Filter
        filter.type = 'lowpass';
        
        // Map slider values
        const cutoffBaseHz = Math.pow(2, (parseFloat(vcfCutoff.value) / 100) * 8.5) * 40; // 40Hz to 14kHz
        const resonanceQ = (parseFloat(vcfRes.value) / 100) * 15 + 0.5; // Q from 0.5 to 15.5
        const envDepthHz = (parseFloat(vcfEnv.value) / 100) * 6000;
        const lfoDepthHz = (parseFloat(vcfLfo.value) / 100) * 500;
        const keyFollowCoeff = parseFloat(vcfKey.value) / 100;

        // Key tracking
        const keyTrackingFreq = cutoffBaseHz + (noteNum - 48) * 10 * keyFollowCoeff;
        const finalCutoffBase = Math.max(30, Math.min(20000, keyTrackingFreq));

        filter.frequency.setValueAtTime(finalCutoffBase, time);
        filter.Q.setValueAtTime(resonanceQ, time);

        // VCF ADSR envelope trigger
        const aT = (parseInt(envAttack.value) / 100) * 1.5 + 0.002;
        const dT = (parseInt(envDecay.value) / 100) * 2.0 + 0.01;
        const sL = parseInt(envSustain.value) / 100;
        const rT = (parseInt(envRelease.value) / 100) * 2.5 + 0.01;

        if (envDepthHz > 0) {
            filter.frequency.setValueAtTime(finalCutoffBase, time);
            filter.frequency.linearRampToValueAtTime(finalCutoffBase + envDepthHz, time + aT);
            filter.frequency.linearRampToValueAtTime(finalCutoffBase + envDepthHz * sL, time + aT + dT);
            // Release filter phase starting at release time
            filter.frequency.setValueAtTime(finalCutoffBase + envDepthHz * sL, time + duration);
            filter.frequency.exponentialRampToValueAtTime(Math.max(30, finalCutoffBase), time + duration + rT);
        }

        // LFO modulation to filter
        if (lfoDepthHz > 0) {
            const modLfo = audioCtx.createOscillator();
            const modLfoGain = audioCtx.createGain();
            
            modLfo.frequency.value = parseFloat(lfoRate.value);
            // Map selected LFO wave
            modLfo.type = lfoWave.value;
            modLfoGain.gain.value = lfoDepthHz;
            
            modLfo.connect(modLfoGain);
            modLfoGain.connect(filter.frequency);
            
            modLfo.start(time);
            modLfo.stop(time + duration + rT + 1.0);
        }

        // 8. VCA Envelope (Gate vs ADSR Env mode)
        const peakGain = isAccent ? 0.38 : 0.22;
        
        filter.connect(masterGain);
        masterGain.connect(audioCtx.destination);

        if (vcaMode.value === 'gate') {
            // Simple gate mode: instantly on, off at end of note
            masterGain.gain.setValueAtTime(0, time);
            masterGain.gain.linearRampToValueAtTime(peakGain, time + 0.002);
            masterGain.gain.setValueAtTime(peakGain, time + duration - 0.002);
            masterGain.gain.linearRampToValueAtTime(0, time + duration + 0.002);
        } else {
            // ADSR Envelope mode
            masterGain.gain.setValueAtTime(0, time);
            // Attack
            masterGain.gain.linearRampToValueAtTime(peakGain, time + aT);
            // Decay
            masterGain.gain.linearRampToValueAtTime(peakGain * sL, time + aT + dT);
            // Hold Sustain until release trigger
            masterGain.gain.setValueAtTime(peakGain * sL, time + duration);
            // Release
            masterGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + rT);
        }

        // 9. Start Oscillators
        oscSaw.start(time);
        oscPulse.start(time);
        oscSub.start(time);
        noiseNode.start(time);

        // Stop Oscillators (Release time buffer added)
        const stopTime = time + duration + rT + 0.1;
        oscSaw.stop(stopTime);
        oscPulse.stop(stopTime);
        oscSub.stop(stopTime);
        noiseNode.stop(stopTime);
    }

    // Playback loop scheduler
    function scheduler() {
        while (nextStepTime < audioCtx.currentTime + scheduleAheadTime) {
            scheduleStep(playStepIndex, nextStepTime);
            advanceStep();
        }
        schedulerTimer = setTimeout(scheduler, lookahead);
    }

    function scheduleStep(stepIdx, time) {
        const step = sequence[stepIdx];
        
        // Highlight active playing step visually
        setTimeout(() => {
            highlightStep(stepIdx);
        }, (time - audioCtx.currentTime) * 1000);

        if (step.type === 'rest') return;

        // Calculate note duration (16th note default)
        const secondsPerStep = 60.0 / bpm / 4;
        let duration = step.slide ? secondsPerStep * 0.95 : secondsPerStep * 0.6;

        // Check if tied next: extend note duration
        let tiesCount = 0;
        for (let j = stepIdx + 1; j < numSteps; j++) {
            if (sequence[j].type === 'tie') tiesCount++;
            else break;
        }
        // Loop wrapping tie check
        if (stepIdx + tiesCount >= numSteps - 1) {
            for (let j = 0; j < (stepIdx + tiesCount) % numSteps; j++) {
                if (sequence[j].type === 'tie') tiesCount++;
                else break;
            }
        }
        duration += tiesCount * secondsPerStep;

        playSynthNote(step.note, time, duration, step.accent, step.slide);
    }

    function advanceStep() {
        const secondsPerStep = 60.0 / bpm / 4;
        nextStepTime += secondsPerStep;
        playStepIndex = (playStepIndex + 1) % numSteps;
    }

    function highlightStep(stepIdx) {
        playbackStep = stepIdx;
        
        // Highlight LEDs in Step Sequencer grid
        const cells = stepGrid.querySelectorAll('.sh-step-cell');
        cells.forEach((cell, idx) => {
            const led = cell.querySelector('.sh-step-led');
            if (idx === stepIdx) {
                cell.classList.add('playing-step');
                if (led) led.classList.add('active');
                
                // Also highlight visual keyboard key
                const note = sequence[idx].note;
                highlightKeyboardKey(note);
            } else {
                cell.classList.remove('playing-step');
                if (led) led.classList.remove('active');
            }
        });

        // Trigger red logo LED
        if (playLed) playLed.classList.add('active');

        // Draw piano roll sweep line
        drawPianoRoll();
    }

    function highlightKeyboardKey(noteNum) {
        const keys = document.querySelectorAll('#keyboard .key-white, #keyboard .key-black');
        keys.forEach(key => {
            if (parseInt(key.dataset.note) === noteNum) {
                key.classList.add('active');
                setTimeout(() => key.classList.remove('active'), 120);
            }
        });
    }

    function togglePlayback() {
        initAudio();
        if (isPlaying) {
            // Stop
            isPlaying = false;
            clearTimeout(schedulerTimer);
            playBtn.classList.remove('playing');
            if (playLed) playLed.classList.remove('active');
            playbackStep = -1;
            
            // Remove active LED highlights
            const cells = stepGrid.querySelectorAll('.sh-step-cell');
            cells.forEach(cell => {
                cell.classList.remove('playing-step');
                const led = cell.querySelector('.sh-step-led');
                if (led) led.classList.remove('active');
            });
            drawPianoRoll();
        } else {
            // Start
            isPlaying = true;
            playStepIndex = 0;
            nextStepTime = audioCtx.currentTime + 0.05;
            playBtn.classList.add('playing');
            scheduler();
        }
    }

    // Trigger manual note click on keyboard
    function triggerKeyPreview(noteNum) {
        initAudio();
        const now = audioCtx.currentTime;
        // Manual play is always 0.3s duration, standard gain
        playSynthNote(noteNum, now, 0.3, false, false);
        highlightKeyboardKey(noteNum);
        
        // Visually depress key
        const key = document.querySelector(`#keyboard [data-note="${noteNum}"]`);
        if (key) {
            key.classList.add('active');
            const releaseHandler = () => {
                key.classList.remove('active');
                window.removeEventListener('mouseup', releaseHandler);
            };
            window.addEventListener('mouseup', releaseHandler);
        }
    }

    // ---- MIDI Parsing Logic ----
    function parseMidi(buffer) {
        const data = new Uint8Array(buffer);
        let offset = 0;

        function readString(len) {
            let str = '';
            for (let i = 0; i < len; i++) {
                str += String.fromCharCode(data[offset++]);
            }
            return str;
        }

        function read16() {
            return (data[offset++] << 8) | data[offset++];
        }

        function read32() {
            return (data[offset++] << 24) | (data[offset++] << 16) | (data[offset++] << 8) | data[offset++];
        }

        function readVLQ() {
            let value = 0;
            let b;
            do {
                b = data[offset++];
                value = (value << 7) | (b & 0x7F);
            } while (b & 0x80);
            return value;
        }

        if (readString(4) !== 'MThd') {
            throw new Error('Geen geldig MIDI-bestand (MThd ontbreekt)');
        }
        
        const headerLen = read32();
        if (headerLen < 6) throw new Error('Ongeldige MIDI header lengte');
        
        const format = read16();
        const numTracks = read16();
        const division = read16();
        
        offset += (headerLen - 6);

        if (division & 0x8000) {
            throw new Error('SMPTE timing wordt niet ondersteund');
        }

        const notes = [];
        let detectedBpm = 120;
        
        for (let t = 0; t < numTracks; t++) {
            while (offset < data.length) {
                const chunkType = readString(4);
                const chunkLen = read32();
                if (chunkType === 'MTrk') {
                    const trackEndOffset = offset + chunkLen;
                    let currentTick = 0;
                    let runningStatus = 0;
                    const activeNoteOns = {};

                    while (offset < trackEndOffset && offset < data.length) {
                        const delta = readVLQ();
                        currentTick += delta;

                        let status = data[offset];
                        if (status < 0x80) {
                            status = runningStatus;
                        } else {
                            offset++;
                            runningStatus = status;
                        }

                        const eventType = status & 0xF0;

                        if (status === 0xFF) {
                            const metaType = data[offset++];
                            const metaLen = readVLQ();
                            const metaStart = offset;

                            if (metaType === 0x51 && metaLen === 3) {
                                const tempo = (data[offset] << 16) | (data[offset+1] << 8) | data[offset+2];
                                detectedBpm = Math.round(60000000 / tempo);
                            }
                            offset = metaStart + metaLen;
                        } else if (status === 0xF0 || status === 0xF7) {
                            const sysexLen = readVLQ();
                            offset += sysexLen;
                        } else {
                            if (eventType === 0x90) {
                                const noteNum = data[offset++];
                                const velocity = data[offset++];
                                if (velocity > 0) {
                                    activeNoteOns[noteNum] = { startTick: currentTick, velocity };
                                } else {
                                    if (activeNoteOns[noteNum]) {
                                        const on = activeNoteOns[noteNum];
                                        notes.push({
                                            note: noteNum,
                                            startTick: on.startTick,
                                            endTick: currentTick,
                                            velocity: on.velocity
                                        });
                                        delete activeNoteOns[noteNum];
                                    }
                                }
                            } else if (eventType === 0x80) {
                                const noteNum = data[offset++];
                                const velocity = data[offset++];
                                if (activeNoteOns[noteNum]) {
                                    const on = activeNoteOns[noteNum];
                                    notes.push({
                                        note: noteNum,
                                        startTick: on.startTick,
                                        endTick: currentTick,
                                        velocity: on.velocity
                                    });
                                    delete activeNoteOns[noteNum];
                                }
                            } else if (eventType === 0xA0 || eventType === 0xB0 || eventType === 0xE0) {
                                offset += 2;
                            } else if (eventType === 0xC0 || eventType === 0xD0) {
                                offset += 1;
                            }
                        }
                    }
                    offset = trackEndOffset;
                    break;
                } else {
                    offset += chunkLen;
                }
            }
        }

        if (notes.length === 0) {
            throw new Error('Geen MIDI-nootevenementen gevonden in dit bestand');
        }

        return { notes, division, bpm: detectedBpm };
    }

    // ---- SEQ Parser ----
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

    // ---- SEQ Generator ----
    function createSeqBuffer(seqArray = sequence, size = numSteps) {
        if (size > 32) throw new Error("A SEQ file can be maximum 32 steps.");
        const payloadLength = 6 + size * 8;
        const totalLength = 44 + size * 8;
        const data = new Uint8Array(totalLength);

        data.set(MAGIC, 0);

        // "MS101" UTF-16BE
        data.set([0, 0, 0, 10], 4);
        data.set([0, 0x4D, 0, 0x53, 0, 0x31, 0, 0x30, 0, 0x31], 8);
        data.set([0, 0], 18);

        // "1.1.14" UTF-16BE
        data.set([0, 12], 20);
        data.set([0, 0x31, 0, 0x2E, 0, 0x31, 0, 0x2E, 0, 0x31, 0, 0x34], 22);
        data.set([0, 0], 34);

        data.set([(payloadLength >> 8) & 0xFF, payloadLength & 0xFF], 36);
        data.set([0, 0, 0, 1, 0, 7], 38);

        for (let i = 0; i < size; i++) {
            const step = seqArray[i];
            const off = STEP_OFFSET + i * STEP_SIZE;

            let note = step.note;
            let octave, semitone;
            
            if (note >= 48) {
                octave = 3;
                semitone = note - 48;
            } else {
                octave = 2;
                semitone = note - 36;
            }

            const gate = step.slide ? 0x07 : 0x03;
            
            let flags = 0;
            if (step.type === 'rest') flags |= 0x08;
            if (step.type === 'tie') flags |= 0x01;
            if (step.accent) flags |= 0x04;

            data[off] = octave;
            data[off + 1] = semitone;
            data[off + 2] = gate;
            data[off + 3] = 0x00;
            data[off + 4] = 0x04;
            data[off + 5] = 0x00;
            data[off + 6] = flags;
            data[off + 7] = 0x00;
        }

        return data;
    }

    // ---- MIDI Generator ----
    function writeVarLen(value) {
        const bytes = [];
        bytes.push(value & 0x7F);
        value >>= 7;
        while (value > 0) {
            bytes.push((value & 0x7F) | 0x80);
            value >>= 7;
        }
        bytes.reverse();
        return bytes;
    }

    function createMidiBuffer() {
        const ticksPerQuarter = 480;
        const ticksPerStep = ticksPerQuarter / 4;
        
        const gateLong = Math.floor(ticksPerStep * 0.95);
        const gateNormal = Math.floor(ticksPerStep * 0.60);

        const track = [];

        // Tempo meta event
        const usPerQuarter = Math.floor(60000000 / bpm);
        track.push(...writeVarLen(0));
        track.push(0xFF, 0x51, 0x03);
        track.push((usPerQuarter >> 16) & 0xFF, (usPerQuarter >> 8) & 0xFF, usPerQuarter & 0xFF);

        // Track name
        const name = Array.from(new TextEncoder().encode('SH-101 Sequence'));
        track.push(...writeVarLen(0));
        track.push(0xFF, 0x03, ...writeVarLen(name.length), ...name);

        // Program change
        track.push(...writeVarLen(0));
        track.push(0xC0, 81);

        let prevGateEnd = 0;
        const channel = 0;

        for (let i = 0; i < numSteps; i++) {
            const step = sequence[i];
            const currentStepStartTick = i * ticksPerStep;

            if (step.type === 'rest' || step.type === 'tie') {
                continue; // Silence or handled as extension
            }

            let duration = step.slide ? gateLong : gateNormal;
            
            let tiesCount = 0;
            for (let j = i + 1; j < numSteps; j++) {
                if (sequence[j].type === 'tie') tiesCount++;
                else break;
            }

            duration += tiesCount * ticksPerStep;

            const nextIdx = i + tiesCount + 1;
            if (nextIdx < numSteps && sequence[nextIdx].slide) {
                duration = (tiesCount + 1) * ticksPerStep;
            }

            const velocity = step.accent ? 120 : 100;

            const deltaOn = currentStepStartTick - prevGateEnd;
            track.push(...writeVarLen(deltaOn));
            track.push(0x90 | channel, step.note, velocity);

            track.push(...writeVarLen(duration));
            track.push(0x80 | channel, step.note, 0);

            prevGateEnd = currentStepStartTick + duration;
        }

        const totalTicks = numSteps * ticksPerStep;
        const deltaEnd = Math.max(0, totalTicks - prevGateEnd);
        track.push(...writeVarLen(deltaEnd));
        track.push(0xFF, 0x2F, 0x00);

        const midi = [];
        
        // MThd
        midi.push(0x4D, 0x54, 0x68, 0x64);
        midi.push(0, 0, 0, 6);
        midi.push(0, 0);
        midi.push(0, 1);
        midi.push((ticksPerQuarter >> 8) & 0xFF, ticksPerQuarter & 0xFF);

        // MTrk
        midi.push(0x4D, 0x54, 0x72, 0x6B);
        const trackLen = track.length;
        midi.push((trackLen >> 24) & 0xFF, (trackLen >> 16) & 0xFF, (trackLen >> 8) & 0xFF, trackLen & 0xFF);
        midi.push(...track);

        return new Uint8Array(midi);
    }

    // ---- MIDI Notes Mapper ----
    function mapMidiToSequence(midiData) {
        const { notes, division } = midiData;
        const ticksPerStep = division / 4;

        let maxStepInMidi = 0;
        notes.forEach(note => {
            const startStep = Math.round(note.startTick / ticksPerStep);
            const durationSteps = Math.round((note.endTick - note.startTick) / ticksPerStep);
            const endStep = startStep + Math.max(1, durationSteps);
            if (endStep > maxStepInMidi) {
                maxStepInMidi = endStep;
            }
        });
        
        numSteps = Math.max(1, Math.min(MAX_STEPS, maxStepInMidi));
        if (stepCountInput) stepCountInput.value = numSteps;
        sequence.length = numSteps;

        const stepNotes = Array(numSteps).fill(null);
        const pitchValues = [];

        notes.forEach(note => {
            const startStep = Math.round(note.startTick / ticksPerStep);
            const durationSteps = Math.round((note.endTick - note.startTick) / ticksPerStep);
            
            if (startStep >= 0 && startStep < numSteps) {
                if (!stepNotes[startStep]) {
                    stepNotes[startStep] = {
                        pitch: note.note,
                        velocity: note.velocity,
                        durationSteps: Math.max(1, durationSteps),
                        endTick: note.endTick
                    };
                    pitchValues.push(note.note);
                }
            }
        });

        // Transposition calculation
        let transposeOffset = 0;
        if (pitchValues.length > 0) {
            const avgPitch = pitchValues.reduce((a, b) => a + b, 0) / pitchValues.length;
            const targetPitch = 48; // C3
            const octaveDiff = Math.round((targetPitch - avgPitch) / 12);
            transposeOffset = octaveDiff * 12;

            let transposedPitches = pitchValues.map(p => p + transposeOffset);
            let minTransposed = Math.min(...transposedPitches);
            let maxTransposed = Math.max(...transposedPitches);

            if (minTransposed < MIN_NOTE) {
                transposeOffset += 12;
            } else if (maxTransposed > MAX_NOTE) {
                transposeOffset -= 12;
            }
        }

        const userTranspose = parseInt(transposeInput.value) || 0;
        const totalTranspose = transposeOffset + userTranspose;

        let lastPlayedNote = 48;

        for (let i = 0; i < numSteps; i++) {
            const noteData = stepNotes[i];

            if (noteData) {
                const rawNote = noteData.pitch + totalTranspose;
                const note = Math.max(MIN_NOTE, Math.min(MAX_NOTE, rawNote));
                lastPlayedNote = note;

                let isSlide = noteData.durationSteps > 1;
                const nextStepStartTick = (i + 1) * ticksPerStep;
                if (noteData.endTick >= nextStepStartTick - 10) {
                    isSlide = true;
                }

                sequence[i] = {
                    type: 'play',
                    note: note,
                    accent: noteData.velocity > 110,
                    slide: isSlide
                };
            } else {
                let isTied = false;
                let activeNotePitch = lastPlayedNote;

                for (let j = i - 1; j >= 0; j--) {
                    const prevNote = stepNotes[j];
                    if (prevNote) {
                        const noteEndTick = prevNote.startTick + (prevNote.durationSteps * ticksPerStep);
                        if (noteEndTick > i * ticksPerStep + (ticksPerStep / 2)) {
                            isTied = true;
                            const rawNote = prevNote.pitch + totalTranspose;
                            activeNotePitch = Math.max(MIN_NOTE, Math.min(MAX_NOTE, rawNote));
                        }
                        break;
                    }
                }

                sequence[i] = {
                    type: isTied ? 'tie' : 'rest',
                    note: activeNotePitch,
                    accent: false,
                    slide: false
                };
            }
        }

        return totalTranspose;
    }

    // ---- UI Rendering functions ----

    function buildStepGridHTML() {
        stepGrid.innerHTML = '';
        sequence.forEach((step, i) => {
            const cell = document.createElement('div');
            cell.className = 'sh-step-cell';
            cell.dataset.index = i;

            // Pitch options dropdown
            let noteOptionsHTML = '';
            noteOptions.forEach(opt => {
                const selected = (opt.value === step.note) ? 'selected' : '';
                noteOptionsHTML += `<option value="${opt.value}" ${selected}>${opt.name}</option>`;
            });

            // Set button label class
            let btnClass = '';
            let btnLabel = noteOptions.find(o => o.value === step.note).name;
            if (step.type === 'rest') {
                btnClass = 'step-rest';
                btnLabel = 'REST';
            } else if (step.type === 'tie') {
                btnClass = 'step-tie';
                btnLabel = 'TIE';
            }

            cell.innerHTML = `
                <div class="sh-step-led"></div>
                <button class="btn-sh-step ${btnClass}" title="Teken noot/rust/tie">${btnLabel}</button>
                <select class="sh-step-note-sel" title="Toonhoogte" ${step.type === 'rest' ? 'style="visibility:hidden"' : ''}>
                    ${noteOptionsHTML}
                </select>
                <div class="sh-step-modifiers">
                    <button class="sh-mod-btn ${step.accent ? 'active-acc' : ''}" data-type="accent" title="Accent">A</button>
                    <button class="sh-mod-btn ${step.slide ? 'active-sld' : ''}" data-type="slide" title="Slide">S</button>
                </div>
            `;

            // Button click cycles Play -> Rest -> Tie -> Play
            cell.querySelector('.btn-sh-step').addEventListener('click', () => {
                if (step.type === 'play') step.type = 'rest';
                else if (step.type === 'rest') step.type = 'tie';
                else step.type = 'play';
                
                updateStateAndRedraw();
            });

            // Pitch selector change
            cell.querySelector('.sh-step-note-sel').addEventListener('change', (e) => {
                step.note = parseInt(e.target.value);
                updateStateAndRedraw();
            });

            // Modifiers A/S click
            cell.querySelectorAll('.sh-mod-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const modType = btn.dataset.type;
                    if (modType === 'accent') {
                        step.accent = !step.accent;
                    } else if (modType === 'slide') {
                        step.slide = !step.slide;
                    }
                    updateStateAndRedraw();
                });
            });

            stepGrid.appendChild(cell);
        });
    }

    // Dynamic keyboard structure generation
    function buildKeyboard() {
        const kbd = document.getElementById('keyboard');
        kbd.innerHTML = '';
        
        const isBlack = [false, true, false, true, false, false, true, false, true, false, true, false];
        
        // Count white keys
        let whiteKeyCount = 0;
        for (let n = MIN_NOTE; n <= MAX_NOTE; n++) {
            if (!isBlack[n % 12]) whiteKeyCount++;
        }
        
        const whiteKeyWidthPercent = 100 / whiteKeyCount;
        const whiteKeysMap = {}; 
        let currentWhiteIdx = 0;
        
        // Render white keys first
        for (let n = MIN_NOTE; n <= MAX_NOTE; n++) {
            const semi = n % 12;
            if (!isBlack[semi]) {
                const key = document.createElement('div');
                key.className = 'key-white';
                key.dataset.note = n;
                key.style.width = `${whiteKeyWidthPercent}%`;
                
                key.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    triggerKeyPreview(n);
                });
                kbd.appendChild(key);
                
                whiteKeysMap[n] = currentWhiteIdx;
                currentWhiteIdx++;
            }
        }
        
        // Render overlapping black keys
        for (let n = MIN_NOTE; n <= MAX_NOTE; n++) {
            const semi = n % 12;
            if (isBlack[semi]) {
                const key = document.createElement('div');
                key.className = 'key-black';
                key.dataset.note = n;
                
                const prevWhiteIdx = whiteKeysMap[n - 1];
                const leftOffset = (prevWhiteIdx + 1) * whiteKeyWidthPercent;
                // Center alignment calculation
                key.style.left = `calc(${leftOffset}% - 1.1%)`;
                
                key.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    triggerKeyPreview(n);
                });
                kbd.appendChild(key);
            }
        }
    }

    // Drawing the Piano Roll
    function drawPianoRoll() {
        const canvas = pianoRoll;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;

        const displayWidth = canvas.parentNode.clientWidth || 800;
        const displayHeight = 160;

        canvas.width = displayWidth * dpr;
        canvas.height = displayHeight * dpr;
        canvas.style.height = displayHeight + 'px';
        ctx.scale(dpr, dpr);

        const w = displayWidth;
        const h = displayHeight;
        const padding = { top: 6, bottom: 16, left: 42, right: 8 };
        const gridW = w - padding.left - padding.right;
        const gridH = h - padding.top - padding.bottom;

        ctx.fillStyle = '#0e1214';
        ctx.fillRect(0, 0, w, h);

        const noteRange = MAX_NOTE - MIN_NOTE + 1;
        const noteH = gridH / noteRange;
        const stepW = gridW / numSteps;

        // Draw note lines
        for (let n = MIN_NOTE; n <= MAX_NOTE; n++) {
            const y = padding.top + gridH - (n - MIN_NOTE + 1) * noteH;
            const semi = n % 12;
            const isBlackKey = [1, 3, 6, 8, 10].includes(semi);

            if (isBlackKey) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
                ctx.fillRect(padding.left, y, gridW, noteH);
            }

            ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(w - padding.right, y);
            ctx.stroke();

            // Label key Cs
            if (semi === 0) {
                const octave = Math.floor(n / 12) - 1;
                ctx.font = '8px "JetBrains Mono", monospace';
                ctx.fillStyle = '#838e91';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(`C${octave}`, padding.left - 6, y + noteH / 2);
            }
        }

        // Draw step lines
        for (let i = 0; i <= numSteps; i++) {
            const x = padding.left + i * stepW;
            ctx.strokeStyle = i % 4 === 0 ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.02)';
            ctx.lineWidth = i % 4 === 0 ? 1.2 : 0.6;
            ctx.beginPath();
            ctx.moveTo(x, padding.top);
            ctx.lineTo(x, h - padding.bottom);
            ctx.stroke();
        }

        // Draw active sequence rectangles
        const noteGap = 1.0;
        sequence.forEach((step, i) => {
            if (step.type === 'rest') return;

            const x = padding.left + i * stepW + noteGap;
            const y = padding.top + gridH - (step.note - MIN_NOTE + 1) * noteH + noteGap;
            const nw = stepW - noteGap * 2;
            const nh = noteH - noteGap * 2;

            let color = '#838e91';
            
            if (step.type === 'tie') {
                color = '#2c3538';
            } else if (step.accent && step.slide) {
                color = '#e879f9';
            } else if (step.accent) {
                color = '#f97316';
            } else if (step.slide) {
                color = '#0ea5e9';
            } else {
                color = '#a78bfa';
            }

            ctx.fillStyle = color;
            ctx.beginPath();
            
            if (step.type === 'tie') {
                ctx.roundRect(x, y + nh/3, nw, nh/3, 1);
            } else {
                ctx.roundRect(x, y, nw, nh, 2.5);
            }
            ctx.fill();
        });

        // Highlight playing step position
        if (isPlaying && playbackStep >= 0 && playbackStep < numSteps) {
            const x = padding.left + playbackStep * stepW;
            ctx.fillStyle = 'rgba(14, 165, 233, 0.08)';
            ctx.fillRect(x, padding.top, stepW, gridH);
            
            ctx.strokeStyle = 'var(--sh-blue)';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(x, padding.top);
            ctx.lineTo(x, h - padding.bottom);
            ctx.moveTo(x + stepW, padding.top);
            ctx.lineTo(x + stepW, h - padding.bottom);
            ctx.stroke();
        }

        // Step numbers
        ctx.fillStyle = '#4b5254';
        ctx.font = '8px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i < numSteps; i++) {
            const x = padding.left + i * stepW + stepW / 2;
            ctx.fillText((i + 1).toString(), x, h - padding.bottom + 4);
        }
    }

    function handlePianoRollClick(e) {
        const rect = pianoRoll.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const w = rect.width;
        const h = rect.height;
        const padding = { top: 6, bottom: 16, left: 42, right: 8 };
        const gridW = w - padding.left - padding.right;
        const gridH = h - padding.top - padding.bottom;

        if (mouseX < padding.left || mouseX > w - padding.right || mouseY < padding.top || mouseY > h - padding.bottom) {
            return;
        }

        const stepW = gridW / numSteps;
        const noteRange = MAX_NOTE - MIN_NOTE + 1;
        const noteH = gridH / noteRange;

        const stepIdx = Math.floor((mouseX - padding.left) / stepW);
        const noteVal = MAX_NOTE - Math.floor((mouseY - padding.top) / noteH);

        if (stepIdx >= 0 && stepIdx < numSteps && noteVal >= MIN_NOTE && noteVal <= MAX_NOTE) {
            const step = sequence[stepIdx];
            
            if (step.type === 'play' && step.note === noteVal) {
                step.type = 'rest';
            } else {
                step.type = 'play';
                step.note = noteVal;
                // Play live preview
                initAudio();
                const now = audioCtx.currentTime;
                playSynthNote(noteVal, now, 0.35, step.accent, false);
            }
            updateStateAndRedraw();
        }
    }

    // ---- Event Handlers ----

    function updateStateAndRedraw() {
        if (seqPanelTitle) {
            seqPanelTitle.textContent = `${numSteps}-STEP SEQUENCER`;
        }
        buildStepGridHTML();
        drawPianoRoll();
        updateFileMeta();
    }

    function updateFileMeta() {
        const notesCount = sequence.filter(s => s.type === 'play').length;
        const tiesCount = sequence.filter(s => s.type === 'tie').length;
        const restsCount = sequence.filter(s => s.type === 'rest').length;
        
        fileMeta.textContent = `${numSteps} steps · ${bpm} BPM · (${notesCount} plays, ${tiesCount} ties, ${restsCount} rests)`;
    }

    function loadEmptySequence() {
        sequence = Array(numSteps).fill(null).map((_, i) => ({
            type: (i % 2 === 0) ? 'play' : 'rest',
            note: 48,
            accent: false,
            slide: false
        }));
        bpm = 120;
        bpmInput.value = 120;
        tempoDisplay.textContent = 120;
        currentFileName = 'sequence';
        fileName.textContent = 'sequence.seq';
        fileBadge.textContent = 'SEQ';

        fileStatusBar.style.display = 'flex';
        errorCard.style.display = 'none';

        updateStateAndRedraw();
    }

    // ---- File Handling ----
    function handleFile(file) {
        if (!file) return;

        const extension = file.name.split('.').pop().toLowerCase();
        currentFileName = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                if (extension === 'seq') {
                    const steps = parseSeq(e.target.result);
                    sequence = steps;
                    fileBadge.textContent = 'SEQ';
                    fileBadge.style.background = 'var(--sh-red)';
                    fileName.textContent = file.name;
                    
                    fileStatusBar.style.display = 'flex';
                    errorCard.style.display = 'none';
                    updateStateAndRedraw();
                } else if (extension === 'mid' || extension === 'midi') {
                    const midiData = parseMidi(e.target.result);
                    
                    bpm = midiData.bpm;
                    bpmInput.value = bpm;
                    tempoDisplay.textContent = bpm;

                    const appliedTranspose = mapMidiToSequence(midiData);
                    
                    fileBadge.textContent = 'MIDI';
                    fileBadge.style.background = 'var(--sh-blue)';
                    fileName.textContent = file.name;
                    
                    if (appliedTranspose !== 0) {
                        const sign = appliedTranspose > 0 ? '+' : '';
                        console.log(`MIDI Auto-Transposition: ${sign}${appliedTranspose} semitones`);
                    }

                    fileStatusBar.style.display = 'flex';
                    errorCard.style.display = 'none';
                    updateStateAndRedraw();
                } else {
                    throw new Error('Upload een .seq of .mid bestand');
                }
            } catch (err) {
                showError(err.message);
            }
        };
        reader.onerror = () => showError('Fout bij lezen');
        
        reader.readAsArrayBuffer(file);
    }

    function showError(msg) {
        errorText.textContent = msg;
        errorCard.style.display = 'flex';
        fileStatusBar.style.display = 'none';
    }

    // Download SEQ
    function downloadSeq() {
        if (numSteps <= 32) {
            const seqData = createSeqBuffer(sequence, numSteps);
            const blob = new Blob([seqData], { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${currentFileName}.seq`;
            a.click();
            URL.revokeObjectURL(url);
        } else {
            // Split into two 32-step pieces
            const part1 = sequence.slice(0, 32);
            const part2 = sequence.slice(32, Math.min(64, numSteps));
            
            const seq1 = createSeqBuffer(part1, part1.length);
            const seq2 = createSeqBuffer(part2, part2.length);
            
            triggerDownload(seq1, `${currentFileName}_part1.seq`);
            setTimeout(() => triggerDownload(seq2, `${currentFileName}_part2.seq`), 500);
        }
    }

    function triggerDownload(data, filename) {
        const blob = new Blob([data], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Download MIDI
    function downloadMidi() {
        const midiData = createMidiBuffer();
        const blob = new Blob([midiData], { type: 'audio/midi' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${currentFileName}.mid`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // ---- Event Setup ----

    // Drag & Drop
    uploadZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) handleFile(e.target.files[0]);
    });

    uploadZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadZone.classList.add('drag-over');
    });
    uploadZone.addEventListener('dragleave', () => {
        uploadZone.classList.remove('drag-over');
    });
    uploadZone.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });

    // Transport
    playBtn.addEventListener('click', togglePlayback);

    // BPM
    bpmInput.addEventListener('change', (e) => {
        let val = parseInt(e.target.value) || 120;
        val = Math.max(20, Math.min(300, val));
        bpm = val;
        e.target.value = val;
        tempoDisplay.textContent = val;
        updateFileMeta();
    });

    // Step Count
    if (stepCountInput) {
        stepCountInput.addEventListener('change', (e) => {
            let val = parseInt(e.target.value) || 16;
            val = Math.max(1, Math.min(64, val));
            numSteps = val;
            e.target.value = val;
            
            // Adjust sequence array size
            const newSeq = Array(numSteps).fill(null).map((_, i) => makeDefaultStep(i));
            for (let i = 0; i < Math.min(sequence.length, numSteps); i++) {
                newSeq[i] = sequence[i];
            }
            sequence = newSeq;

            updateStateAndRedraw();
        });
    }

    // Octave Shift dropdown (Applies offset shift dynamically)
    transposeInput.addEventListener('change', () => {
        const diff = parseInt(transposeInput.value) || 0;
        if (diff !== 0) {
            sequence.forEach(step => {
                step.note = Math.max(MIN_NOTE, Math.min(MAX_NOTE, step.note + diff));
            });
            transposeInput.value = "0"; // reset
            updateStateAndRedraw();
        }
    });

    // Clear
    clearBtn.addEventListener('click', () => {
        if (confirm('Weet u zeker dat u de sequencer leeg wilt maken?')) {
            loadEmptySequence();
        }
    });

    // Downloads
    downloadSeqBtn.addEventListener('click', downloadSeq);
    downloadMidiBtn.addEventListener('click', downloadMidi);

    // Piano Roll Click Event
    pianoRoll.addEventListener('mousedown', handlePianoRollClick);

    // Resize
    window.addEventListener('resize', () => {
        drawPianoRoll();
    });

    // ---- Initialize App ----
    buildKeyboard();
    loadEmptySequence();

})();
