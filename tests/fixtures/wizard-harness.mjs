// Driven by tests/wizard.test.mjs. Runs one wizard component with whatever keys arrive on stdin
// and prints the result as JSON on the last line, so the test can assert on it without a terminal.
//
// This exists because lib/wizard.mjs talks to process.stdin directly — which is correct, since two
// consumers of stdin in one process is the bug its comments are about — so the only honest way to
// test it is from outside, in a child process with a pipe.

import { textInput, multiSelect, chooseAction, closeInput } from "../../lib/wizard.mjs";

const [mode] = process.argv.slice(2);

const say = (result) => {
  closeInput();
  process.stdout.write(`\n__RESULT__${JSON.stringify(result)}\n`);
};

if (mode === "text") {
  say(await textInput({ heading: "Name", label: ">", placeholder: "type here" }));
} else if (mode === "text-initial") {
  say(await textInput({ heading: "Name", label: ">", initial: "workspace" }));
} else if (mode === "text-validate") {
  // Refuses everything short, so the test can prove enter does not close a field that failed.
  const value = await textInput({
    heading: "Name",
    label: ">",
    validate: (v) => (v.length < 3 ? "too short" : null),
  });
  say(value);
} else if (mode === "text-then-menu") {
  // The sequence the host setup actually performs: type something, hand the terminal away, take it
  // back, and show a menu. Re-arming used to double every keypress.
  const typed = await textInput({ heading: "Name", label: ">" });
  closeInput();
  const picked = await multiSelect({
    heading: "Pick",
    items: [
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ],
    selected: [],
  });
  say({ typed, picked: picked ? [...picked] : null });
} else if (mode === "menu") {
  const picked = await multiSelect({
    heading: "Pick",
    items: [
      { value: "a", label: "a" },
      { value: "b", label: "b" },
      { value: "c", label: "c" },
    ],
    selected: [],
  });
  say(picked ? [...picked] : null);
} else if (mode === "confirm") {
  say(await chooseAction({
    heading: "Ready",
    items: [
      { value: "go", label: "Install" },
      { value: "cancel", label: "Cancel" },
    ],
  }));
} else {
  process.stdout.write("unknown mode\n");
  process.exitCode = 2;
}
