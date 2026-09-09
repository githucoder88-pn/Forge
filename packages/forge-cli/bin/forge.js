#!/usr/bin/env -S node --no-warnings
// Forge CLI launcher. Suppresses Node's experimental warnings (node:sqlite)
// so CLI output stays clean; all real warnings still flow through events.
import '../dist/cli.js';
