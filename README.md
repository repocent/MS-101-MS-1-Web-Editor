# MS-101/MS-1 Clean Web Editor

A highly dynamic, minimalist version of the Behringer MS-101/MS-1 Sequencer Web Editor.

## Overview

This "Clean Edition" focuses on visual clarity and workflow efficiency. The UI dynamically adapts to your sequence length—no more, no less. It also automatically manages hardware limitations when exporting.

## Key Features

- **Dynamic UI Sizing**: The sequencer interface and piano roll dynamically expand or contract to exactly match the length of your sequence. If you load a 16-step MIDI file, you see exactly 16 steps. If you load a 48-step file, you see 48 steps.
- **Smart Split Export**: The Behringer MS-101 natively supports a maximum of 32 steps per `.seq` file. If your pattern exceeds 32 steps (e.g., a 64-step sequence), the editor will automatically split your work into multiple chunks (e.g., `part1.seq` and `part2.seq`) of 32 steps when you click Export.
- **Clean Interface**: Extraneous marketing copy and help sections have been removed for a professional, distraction-free environment.
- **MS-101 / MS-1 Ready**: Accurate branding and binary compatibility with the Behringer SynthTribe application.
- **Adjusted VCO UI**: Features the requested PULSE and SAW slider swap for a preferred synthesis workflow.

## How to Run

No build tools or web servers are strictly required.
1. Download or clone this repository.
2. Open `ms1_clean.html` in any modern web browser (Chrome, Edge, Firefox, Safari).
3. Drag and drop your `.mid` or `.seq` files to begin editing!

## Files Included

- `ms1_clean.html`: The minimalist HTML interface.
- `app_clean.js`: The underlying engine driving the dynamic UI scaling and smart sequence chunking.
- `style.css`: The styling rules defining the aesthetic.
