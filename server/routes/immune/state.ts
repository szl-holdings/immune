export type ImmuneMode = "PASS" | "SENTRA_REJECT" | "DEADMAN";

interface State {
  mode: ImmuneMode;
  tripwire: string | null;
  deadman: boolean;
}

const state: State = {
  mode: "PASS",
  tripwire: null,
  deadman: false,
};

export function getState(): State {
  return { ...state };
}

export function setState(mode: ImmuneMode, tripwire: string | null): State {
  state.mode = mode;
  state.tripwire = mode === "DEADMAN" ? tripwire : null;
  state.deadman = mode === "DEADMAN";
  return getState();
}

export function clearDeadman(): State {
  state.mode = "PASS";
  state.tripwire = null;
  state.deadman = false;
  return getState();
}
