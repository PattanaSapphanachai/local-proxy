import { readFile } from "node:fs/promises";
import { startGateway } from "./app.ts";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
const running = await startGateway({ version });
console.log(`AI gateway listening on ${running.url}`);
