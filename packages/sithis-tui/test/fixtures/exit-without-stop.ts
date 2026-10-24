import { ProcessTerminal } from "../../src/terminal.ts";
import { TuiAltScreen } from "../../src/tui-alt-screen.ts";

const tui = new TuiAltScreen(new ProcessTerminal(), false, undefined, { mouse: true });
tui.start();
if (process.argv[2] === "stop") {
	tui.stop({ preserveScreen: true });
	// A pipe is asynchronous on some Node builds; keep the restore writes before exit.
	await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
}
process.exit(0);
