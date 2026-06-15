(() => {
    'use strict';

    // ---- Constants ----
    const MAGIC = [0x23, 0x98, 0x54, 0x76];
    const STEP_OFFSET = 44;
    const STEP_SIZE = 8;
    const MAX_STEPS = 64; 
    const MIN_NOTE = 36;
    const MAX_NOTE = 63;

    // ---- DOM Elements ----
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    const statusText = document.getElementById('statusText');

    function makeDefaultStep(i) {
        return {
            type: 'rest',
            note: 48,
            accent: false,
            slide: false,
        };
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

    // ---- MIDI Notes Mapper to 64 Steps ----
    function mapMidiToSequenceArray(midiData) {
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
        
        let numSteps = Math.max(1, Math.min(MAX_STEPS, maxStepInMidi));
        const sequence = Array(numSteps).fill(null).map((_, i) => makeDefaultStep(i));
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

        let lastPlayedNote = 48;

        for (let i = 0; i < numSteps; i++) {
            const noteData = stepNotes[i];

            if (noteData) {
                const rawNote = noteData.pitch + transposeOffset;
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
                            const rawNote = prevNote.pitch + transposeOffset;
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

        return sequence;
    }

    // ---- SEQ Generator ----
    function createSeqBufferFromArray(sequence) {
        const numSteps = sequence.length;
        if (numSteps > 32) {
            throw new Error('Can only generate seq files up to 32 steps.');
        }

        const payloadLength = 6 + numSteps * 8;
        const totalLength = 44 + numSteps * 8;
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

        for (let i = 0; i < numSteps; i++) {
            const step = sequence[i];
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

    function downloadBlob(data, filename) {
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

    function handleFile(file) {
        if (!file) return;

        const extension = file.name.split('.').pop().toLowerCase();
        const baseFileName = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;

        if (extension !== 'mid' && extension !== 'midi') {
            statusText.textContent = "Upload a .mid file (max 64 steps) to split.";
            statusText.style.color = "var(--sh-red)";
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const midiData = parseMidi(e.target.result);
                const sequence = mapMidiToSequenceArray(midiData);
                
                if (sequence.length <= 32) {
                    statusText.textContent = `File is only ${sequence.length} steps. Splitting is not needed, but generating single .seq anyway.`;
                    statusText.style.color = "var(--sh-orange)";
                    const seqData = createSeqBufferFromArray(sequence);
                    downloadBlob(seqData, `${baseFileName}.seq`);
                } else {
                    const part1 = sequence.slice(0, 32);
                    const part2 = sequence.slice(32, Math.min(64, sequence.length));
                    
                    const seq1 = createSeqBufferFromArray(part1);
                    const seq2 = createSeqBufferFromArray(part2);
                    
                    statusText.textContent = `Succesfully split ${sequence.length} steps into two files!`;
                    statusText.style.color = "var(--sh-blue)";
                    
                    downloadBlob(seq1, `${baseFileName}_part1.seq`);
                    
                    // Add slight delay to allow second download
                    setTimeout(() => {
                        downloadBlob(seq2, `${baseFileName}_part2.seq`);
                    }, 500);
                }

            } catch (err) {
                statusText.textContent = "Error: " + err.message;
                statusText.style.color = "var(--sh-red)";
            }
        };
        reader.readAsArrayBuffer(file);
    }

    // ---- Event Setup ----
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

})();
