/**
 * Tiny re-export shim so src/health/* depends on a stable surface for the
 * booking-window utilities, without each file reaching across to
 * src/scheduler/booking-window.js directly.
 *
 * Pure passthrough — no logic.
 */
'use strict';

const { getPhase, isPastClass } = require('../scheduler/booking-window');
module.exports = { getPhase, isPastClass };
