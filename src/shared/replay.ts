// Input recording + playback.
//
// Format: array of [tick, inputBitmask] pairs, recorded ONLY when the input
// changes. A 60-second run is typically well under 1 KB as JSON — trivially
// inside Devvit Redis limits.
//
// Recorder and Replayer expose the same { getInput(tick) } shape, so live play,
// ghost playback, and server validation all drive the SAME sim.step() — that
// is what makes ghosts exact by construction.

export type ReplayEvent = [tick: number, input: number];

export type InputSource = { getInput(tick: number): number };

export type Recorder = InputSource & { events: ReplayEvent[] };

/** Wrap a live-input poller (reads keyboard/touch OUTSIDE the sim). */
export function makeRecorder(poll: () => number): Recorder {
  const events: ReplayEvent[] = [];
  let last = -1;
  return {
    events,
    getInput(tick: number): number {
      const i = poll();
      if (i !== last) {
        events.push([tick, i]);
        last = i;
      }
      return i;
    },
  };
}

/** Play back a recorded event stream. Holds each value until the next change tick. */
export function makeReplayer(events: ReplayEvent[]): InputSource {
  let idx = 0;
  let current = 0;
  return {
    getInput(tick: number): number {
      while (idx < events.length && events[idx]![0] === tick) {
        current = events[idx]![1]!;
        idx++;
      }
      return current;
    },
  };
}
