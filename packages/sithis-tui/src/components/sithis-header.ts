import { Text } from "./text.ts";

/** Header shared by Sithis hosts; uses the fork's ordinary text layout. */
export class SithisHeader extends Text {
	constructor(version: string, style: (text: string) => string = (text) => text) {
		super(`${style(`Sithis ${version}`)}\n/engagement to manage assessments`, 1, 1);
	}
}
